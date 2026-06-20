"""FastAPI entrypoint for the pipeline container.

The Worker (via the PipelineContainer Durable Object) calls:
  POST /metadata  {source_url, platform}          -> metadata dict
  POST /process   {item_id, source_url, platform, mode, transcript?}
                                                   -> PipelineResult JSON
"""

from __future__ import annotations

import logging
import os
import subprocess

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import pipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pipeline")

app = FastAPI(title="stream-reduce-pipeline")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


def _curl(args: list[str], timeout: int = 25) -> str:
    out = subprocess.run(  # noqa: S603
        ["curl", "-sS", "--max-time", str(timeout), *args],
        capture_output=True,
        text=True,
        timeout=timeout + 5,
    )
    return (out.stdout or out.stderr).strip()


@app.get("/proxy-check")
def proxy_check() -> dict:
    """Diagnostic for the WARP egress spike: for each entry in PROXY_URLS report
    the egress IP (via cloudflare trace) and Bilibili's risk-control verdict.
    """
    raw = os.environ.get("PROXY_URLS", "").strip()
    candidates = [p.strip() for p in raw.split(",") if p.strip()] or ["direct"]
    results = []
    for proxy in candidates:
        socks = [] if proxy.lower() == "direct" else ["--socks5-hostname", proxy.split("://", 1)[-1]]
        trace = _curl([*socks, "https://www.cloudflare.com/cdn-cgi/trace"])
        ip = next((ln.split("=", 1)[1] for ln in trace.splitlines() if ln.startswith("ip=")), None)
        loc = next((ln.split("=", 1)[1] for ln in trace.splitlines() if ln.startswith("loc=")), None)
        warp = next((ln.split("=", 1)[1] for ln in trace.splitlines() if ln.startswith("warp=")), None)
        zone = _curl([*socks, "https://api.bilibili.com/x/web-interface/zone"])
        results.append({"proxy": proxy, "ip": ip, "loc": loc, "warp": warp, "bili_zone": zone[:300]})
    return {"proxy_urls": raw, "results": results}


@app.post("/metadata")
async def metadata(request: Request):
    body = await request.json()
    try:
        return pipeline.fetch_metadata(body["source_url"], body.get("platform"), body.get("bilibili_cookie"))
    except Exception as exc:  # noqa: BLE001
        logger.exception("metadata failed")
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)


@app.post("/feed_entries")
async def feed_entries(request: Request):
    body = await request.json()
    try:
        return pipeline.fetch_feed_entries(body["source_url"], int(body.get("limit", 300)))
    except Exception as exc:  # noqa: BLE001
        logger.exception("feed_entries failed for %s", body.get("source_url"))
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)


@app.post("/process")
async def process(request: Request):
    body = await request.json()
    try:
        return pipeline.run(body)
    except Exception as exc:  # noqa: BLE001
        logger.exception("process failed for %s", body.get("source_url"))
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)
