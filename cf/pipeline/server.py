"""FastAPI entrypoint for the pipeline container.

The Worker (via the PipelineContainer Durable Object) calls:
  POST /metadata  {source_url, platform}          -> metadata dict
  POST /process   {item_id, source_url, platform, mode, transcript?}
                                                   -> PipelineResult JSON
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import pipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pipeline")

app = FastAPI(title="stream-reduce-pipeline")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/metadata")
async def metadata(request: Request):
    body = await request.json()
    try:
        return pipeline.fetch_metadata(body["source_url"], body.get("platform"))
    except Exception as exc:  # noqa: BLE001
        logger.exception("metadata failed")
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)


@app.post("/process")
async def process(request: Request):
    body = await request.json()
    try:
        return pipeline.run(body)
    except Exception as exc:  # noqa: BLE001
        logger.exception("process failed for %s", body.get("source_url"))
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)
