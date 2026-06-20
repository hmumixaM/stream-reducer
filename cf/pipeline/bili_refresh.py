"""Bilibili web cookie refresh, executed inside the container so the HTTP calls
egress through WARP (PROXY_URLS) instead of the Worker's Cloudflare datacenter
IP — Bilibili risk-controls the passport.bilibili.com endpoints from datacenter
IPs (HTTP 412), so the refresh must run from a WARP exit.

The Worker (lib/biliRefresh.ts) POSTs {cookie, refresh_token, force} to the
/refresh-cookie endpoint and persists the returned {cookie, refresh_token} back
to KV. Flow per the bilibili-API-collect login docs:
  1. GET  /x/passport-login/web/cookie/info?csrf=<bili_jct> -> {refresh, timestamp}
  2. correspondPath = hex(RSA-OAEP-SHA256(pubkey, "refresh_"+timestamp))
     GET https://www.bilibili.com/correspond/1/<path>       -> #1-name = refresh_csrf
  3. POST /x/passport-login/web/cookie/refresh              -> new Set-Cookie + new refresh_token
  4. POST /x/passport-login/web/confirm/refresh (new csrf, OLD token)
"""

from __future__ import annotations

import binascii
import logging
import os
import re

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

logger = logging.getLogger("pipeline")

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Bilibili's well-known RSA public key for correspondPath generation.
_PUBKEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----"""


def _correspond_path(timestamp: int) -> str:
    pub = serialization.load_pem_public_key(_PUBKEY_PEM)
    ciphertext = pub.encrypt(
        f"refresh_{timestamp}".encode(),
        padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
    )
    return binascii.hexlify(ciphertext).decode()


def _proxy_candidates() -> list[str | None]:
    """Same PROXY_URLS contract as the yt-dlp adapter: WARP SOCKS5 proxies first,
    then `direct`. Refresh rotates through them until one isn't risk-controlled."""
    raw = os.environ.get("PROXY_URLS", "").strip()
    if not raw:
        return [None]
    out: list[str | None] = []
    for part in raw.split(","):
        p = part.strip()
        if p:
            out.append(None if p.lower() == "direct" else p)
    return out or [None]


def _parse_cookie(s: str) -> dict[str, str]:
    jar: dict[str, str] = {}
    for part in (s or "").split(";"):
        t = part.strip()
        if "=" in t:
            k, v = t.split("=", 1)
            if k.strip():
                jar[k.strip()] = v.strip()
    return jar


def _serialize(jar: dict[str, str]) -> str:
    return "; ".join(f"{k}={v}" for k, v in jar.items())


def refresh(cookie: str, refresh_token: str, force: bool = False) -> dict:
    """Refresh the cookie if Bilibili says it needs it (or force). Returns
    {refreshed, reason, cookie?, refresh_token?}. Never raises — errors are
    reported in `reason` so the Worker keeps the previous KV value."""
    if not cookie:
        return {"refreshed": False, "reason": "no cookie"}
    if not refresh_token:
        return {"refreshed": False, "reason": "no refresh_token"}
    jar = _parse_cookie(cookie)
    if not jar.get("bili_jct"):
        return {"refreshed": False, "reason": "cookie missing bili_jct"}

    last_err: Exception | None = None
    for proxy in _proxy_candidates():
        try:
            return _refresh_once(dict(jar), jar["bili_jct"], refresh_token, force, proxy)
        except Exception as exc:  # noqa: BLE001 — rotate to the next proxy
            last_err = exc
            logger.warning("bili refresh via proxy=%s failed: %s", proxy or "direct", exc)
            continue
    return {"refreshed": False, "reason": f"{type(last_err).__name__}: {last_err}"}


def _refresh_once(jar: dict[str, str], csrf: str, refresh_token: str, force: bool, proxy: str | None) -> dict:
    cookie_str = _serialize(jar)
    with httpx.Client(proxy=proxy, headers={"user-agent": UA}, timeout=30, follow_redirects=True) as client:
        info = client.get(
            "https://passport.bilibili.com/x/passport-login/web/cookie/info",
            params={"csrf": csrf},
            headers={"cookie": cookie_str},
        ).json()
        if info.get("code") != 0:
            raise RuntimeError(f"cookie/info code={info.get('code')} {info.get('message')}")
        if not info.get("data", {}).get("refresh") and not force:
            return {"refreshed": False, "reason": "cookie still fresh",
                    "cookie": cookie_str, "refresh_token": refresh_token}
        timestamp = info["data"]["timestamp"]

        path = _correspond_path(timestamp)
        html = client.get(
            f"https://www.bilibili.com/correspond/1/{path}",
            headers={"cookie": cookie_str},
        ).text
        match = re.search(r'<div id="1-name">\s*([0-9a-fA-F]+)\s*</div>', html)
        if not match:
            raise RuntimeError("refresh_csrf not found (correspondPath expired or cookie invalid)")
        refresh_csrf = match.group(1)

        refreshed = client.post(
            "https://passport.bilibili.com/x/passport-login/web/cookie/refresh",
            headers={"cookie": cookie_str, "content-type": "application/x-www-form-urlencoded"},
            data={"csrf": csrf, "refresh_csrf": refresh_csrf, "source": "main_web", "refresh_token": refresh_token},
        )
        rj = refreshed.json()
        if rj.get("code") != 0:
            raise RuntimeError(f"cookie/refresh code={rj.get('code')} {rj.get('message')}")
        new_token = rj.get("data", {}).get("refresh_token")
        if not new_token:
            raise RuntimeError("cookie/refresh returned no refresh_token")

        # Apply the new Set-Cookie values (SESSDATA, bili_jct, DedeUserID, sid, …).
        for name, value in refreshed.cookies.items():
            jar[name] = value
        new_cookie = _serialize(jar)
        new_csrf = jar.get("bili_jct")
        if not new_csrf:
            raise RuntimeError("refreshed cookie missing bili_jct")

        # Confirm with the NEW csrf + the OLD token to invalidate the old cookie.
        confirm = client.post(
            "https://passport.bilibili.com/x/passport-login/web/confirm/refresh",
            headers={"cookie": new_cookie, "content-type": "application/x-www-form-urlencoded"},
            data={"csrf": new_csrf, "refresh_token": refresh_token},
        ).json()
        if confirm.get("code") != 0:
            logger.warning("bili confirm/refresh non-zero: %s %s", confirm.get("code"), confirm.get("message"))

        return {"refreshed": True, "reason": "ok", "cookie": new_cookie, "refresh_token": new_token}
