"""FastAPI entrypoint for the pipeline container.

The Worker (via the PipelineContainer Durable Object) calls:
  POST /metadata  {source_url, platform}          -> metadata dict
  POST /process   {item_id, source_url, platform, mode, transcript?}
                                                   -> PipelineResult JSON
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

import pipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pipeline")

app = FastAPI(title="stream-reduce-pipeline")


BUILD_MARKER = "bld-2026-06-20-v7-summarize-timeout"


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "build": BUILD_MARKER}


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
    return {"build": BUILD_MARKER, "proxy_urls": raw, "results": results}


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


@app.post("/process_stream")
async def process_stream(request: Request):
    """Run the pipeline while streaming newline-delimited JSON progress events so
    the Worker can heartbeat live stage/% into D1. Emits a sequence of
    {"event":"progress", stage, pct, ...} lines, then a terminal
    {"event":"result", result} or {"event":"error", stage, message}.

    Used for download-bearing modes (process). Modes that never download
    (translate / infographic / backfill) keep using /process.
    """
    body = await request.json()
    events: "queue.Queue" = queue.Queue(maxsize=1000)
    sentinel = object()
    state = {"stage": None}

    def on_progress(evt: dict) -> None:
        if evt.get("stage"):
            state["stage"] = evt["stage"]
        try:
            events.put_nowait({"event": "progress", **evt})
        except queue.Full:
            pass  # drop progress under backpressure; never block the pipeline

    def worker() -> None:
        try:
            result = pipeline.run(body, on_progress=on_progress)
            events.put({"event": "result", "result": result})
        except Exception as exc:  # noqa: BLE001 — surface the captured reason
            logger.exception("process_stream failed for %s", body.get("source_url"))
            events.put({"event": "error", "stage": state["stage"], "message": f"{type(exc).__name__}: {exc}"})
        finally:
            events.put(sentinel)

    threading.Thread(target=worker, daemon=True).start()

    def generate():
        while True:
            evt = events.get()
            if evt is sentinel:
                break
            yield json.dumps(evt, ensure_ascii=False) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@app.post("/refresh-cookie")
async def refresh_cookie(request: Request):
    """Run the Bilibili cookie refresh through WARP egress (the Worker IP is
    risk-controlled on passport.bilibili.com). Always 200s; the outcome
    (including any error) is in the body so the Worker can decide whether to
    persist the new cookie to KV."""
    body = await request.json()
    import bili_refresh

    return bili_refresh.refresh(
        body.get("cookie", ""),
        body.get("refresh_token", ""),
        bool(body.get("force")),
    )
