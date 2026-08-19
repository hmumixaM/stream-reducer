"""On-demand Cloudflare WARP egress.

The container's entrypoint brings up a fixed set of WARP SOCKS5 proxies at
start-up. Those exit IPs are fixed for the container's lifetime, so when YouTube
refuses them (its media URLs are bound to the requesting IP and datacenter
ranges get 403s) retrying through the same proxies changes nothing. Registering
a *new* WARP identity yields a new exit IP, which is the one thing that can turn
such a download around, so the yt-dlp adapter asks for one as a last resort.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from itertools import count
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# Ports for on-demand instances start well above the entrypoint's block so they
# can never collide with the proxies it published in PROXY_URLS.
_FRESH_BASE_PORT = 41000

_port_numbers = count(_FRESH_BASE_PORT)

_TRACE_URL = os.environ.get("WARP_TRACE_URL", "https://www.cloudflare.com/cdn-cgi/trace")

# Keep spawned wireproxy processes referenced for the life of the process; they
# are killed when the container exits.
_processes: list[subprocess.Popen] = []


def warp_tooling_available() -> bool:
    return bool(shutil.which("wgcf") and shutil.which("wireproxy"))


def spawn_fresh_warp(timeout: int = 25) -> str | None:
    """Register a brand-new WARP identity and expose it as a local SOCKS5 proxy.

    Returns the proxy URL once it passes traffic, or None when the tooling is
    absent (local dev) or Cloudflare declines the registration (it rate-limits
    per IP). Callers treat None as "no more egress to try".
    """
    if not warp_tooling_available():
        return None
    port = next(_port_numbers)
    tag = f"fresh-{port}"
    toml = f"/tmp/wgcf-{tag}.toml"
    profile = f"/tmp/wgcf-{tag}.conf"
    wireproxy_conf = Path(f"/tmp/wireproxy-{tag}.conf")

    for step in (
        ["wgcf", "register", "--accept-tos", "--config", toml],
        ["wgcf", "generate", "--config", toml, "--profile", profile],
    ):
        done = subprocess.run(step, capture_output=True, text=True, timeout=60)
        if done.returncode != 0:
            logger.warning(
                "fresh WARP %s failed at `%s`: %s",
                tag, step[1], (done.stderr or done.stdout).strip()[-300:],
            )
            return None

    wireproxy_conf.write_text(
        f"WGConfig = {profile}\n\n[Socks5]\nBindAddress = 127.0.0.1:{port}\n"
    )
    log = open(f"/tmp/warp-{tag}.log", "w")  # noqa: SIM115 — lives with the process
    _processes.append(
        subprocess.Popen(["wireproxy", "-c", str(wireproxy_conf)], stdout=log, stderr=log)
    )

    proxy = f"socks5://127.0.0.1:{port}"
    exit_ip = _wait_for_exit_ip(proxy, timeout)
    if not exit_ip:
        logger.warning("fresh WARP %s never completed a handshake", tag)
        return None
    # Log the exit IP: it's the whole point of the rotation, and it's what tells
    # you afterwards whether a retry ran from a different address at all.
    logger.info("fresh WARP egress ready: %s (exit ip %s)", proxy, exit_ip)
    return proxy


def _wait_for_exit_ip(proxy: str, timeout: int) -> str | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            resp = httpx.get(_TRACE_URL, proxy=proxy, timeout=6)
            if resp.status_code == 200:
                fields = dict(
                    line.split("=", 1) for line in resp.text.splitlines() if "=" in line
                )
                return fields.get("ip", "unknown")
        except Exception:  # noqa: BLE001 — handshake still in flight
            pass
        time.sleep(2)
    return None
