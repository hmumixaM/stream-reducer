"""Fetch Bilibili 弹幕 (danmaku / bullet comments).

Bilibili exposes a representative danmaku pool as XML at
``comment.bilibili.com/{cid}.xml``. The ``cid`` is resolved from the video's
BV id via the public view API.
"""

from __future__ import annotations

import logging
import re

import httpx

logger = logging.getLogger(__name__)

_BV_RE = re.compile(r"(BV[0-9A-Za-z]+)")
_DM_RE = re.compile(r'<d p="([^"]+)">([^<]*)</d>')
_VIEW_API = "https://api.bilibili.com/x/web-interface/view"
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_HEADERS = {"User-Agent": _UA, "Referer": "https://www.bilibili.com/"}


def _bvid(url: str) -> str | None:
    m = _BV_RE.search(url)
    return m.group(1) if m else None


def fetch_bilibili_danmaku(
    url: str,
    max_items: int = 4000,
    proxies: list[str | None] | None = None,
    cookie: str | None = None,
) -> list[dict]:
    """Return danmaku as [{"time": float, "text": str}] sorted by time.

    Bilibili IP-risk-controls shared/datacenter egress (the same reason audio
    downloads route through WARP), so the view + danmaku APIs must egress through
    the same proxy candidates. `proxies` is an ordered list of proxy URLs
    (``socks5://…``) / ``None`` (direct), tried in turn until one returns danmaku.
    `cookie` is the logged-in Bilibili cookie header.

    Returns [] on any failure; danmaku are optional and must never break ingest.
    """
    bvid = _bvid(url)
    if not bvid:
        return []
    headers = dict(_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    candidates = list(proxies) if proxies else [None]
    for proxy in candidates:
        try:
            with httpx.Client(proxy=proxy, headers=headers, timeout=30, follow_redirects=True) as client:
                view = client.get(_VIEW_API, params={"bvid": bvid})
                view.raise_for_status()
                vj = view.json()
                if vj.get("code") != 0:
                    raise ValueError(f"view api code={vj.get('code')}")
                cid = vj["data"]["cid"]
                resp = client.get(f"https://comment.bilibili.com/{cid}.xml")
                resp.raise_for_status()
                resp.encoding = "utf-8"
                body = resp.text
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            logger.warning("danmaku fetch via proxy=%s failed for %s: %s", proxy or "direct", url, exc)
            continue

        items: list[dict] = []
        for attrs, text in _DM_RE.findall(body):
            text = text.strip()
            if not text:
                continue
            items.append({"time": float(attrs.split(",")[0]), "text": text})
        if items:
            items.sort(key=lambda d: d["time"])
            return items[:max_items]
        logger.warning("danmaku empty via proxy=%s for %s (%d bytes)", proxy or "direct", url, len(body))
    return []
