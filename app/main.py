"""FastAPI application: REST API + static SPA hosting."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager, nullcontext

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import items, queue, settings, stats, subscriptions
from app.config import PROJECT_ROOT, get_settings
from app.db import init_db
from app.mcp_server import build_mcp_app
from app.media import MEDIA_ROUTE

FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"

# The MCP ASGI app (or None when disabled). Its lifespan runs the Streamable
# HTTP session manager, so it must be entered alongside the app's own lifespan.
mcp_app = build_mcp_app()


@asynccontextmanager
async def lifespan(app_: FastAPI):
    init_db()
    mcp_lifespan = mcp_app.lifespan(app_) if mcp_app is not None else nullcontext()
    async with mcp_lifespan:
        # Only the web process should run the scheduler (not workers).
        if os.getenv("RUN_SCHEDULER", "1") == "1":
            from app.scheduler import shutdown_scheduler, start_scheduler

            start_scheduler()
            try:
                yield
            finally:
                shutdown_scheduler()
        else:
            yield


app = FastAPI(title="stream-reduce", version="0.2.0", lifespan=lifespan)

app.include_router(items.router)
app.include_router(queue.router)
app.include_router(subscriptions.router)
app.include_router(stats.router)
app.include_router(settings.router)

# Mount the MCP server before the SPA catch-all so /mcp routes correctly.
if mcp_app is not None:
    app.mount("/mcp", mcp_app)


@app.get("/api/health")
def health() -> dict:
    from app.runtime_config import effective_llm_model, effective_stt_model

    return {
        "status": "ok",
        "stt_model": effective_stt_model(),
        "llm_model": effective_llm_model(),
    }


def _mount_media() -> None:
    settings = get_settings()
    media_root = settings.resolved_media_dir
    media_root.mkdir(parents=True, exist_ok=True)
    app.mount(MEDIA_ROUTE, StaticFiles(directory=media_root), name="media")


_mount_media()


def _mount_spa() -> None:
    if not FRONTEND_DIST.exists():
        return
    assets = FRONTEND_DIST / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):  # noqa: ANN202
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")


_mount_spa()


def run() -> None:
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000)


if __name__ == "__main__":
    run()
