"""Minimal MCP server exposing stream-reduce to AI agents.

A thin wrapper over the existing ingest pipeline and DB: three tools that let an
agent add content, search the library, and read a summary. Mounted on the web
app at ``/mcp`` (Streamable HTTP) when ``ENABLE_MCP`` is set.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastmcp import FastMCP
from sqlmodel import col, select

from app.config import get_settings
from app.db import session_scope
from app.models import Item, Summary, Transcript

if TYPE_CHECKING:
    from starlette.applications import Starlette

mcp: FastMCP = FastMCP("stream-reduce")


def _brief(item: Item) -> dict:
    """Compact, token-cheap view of an item for list responses."""
    return {
        "id": item.id,
        "title": item.title or item.source_url,
        "status": item.status.value,
        "platform": item.platform.value,
        "source_url": item.source_url,
        "author": item.author,
        "duration_s": item.duration_s,
        "published_at": item.published_at.isoformat() if item.published_at else None,
    }


@mcp.tool
def add_content(urls: list[str]) -> list[dict]:
    """Add media and queue it for transcription + summarization.

    Accepts one or more URLs. A single video/episode becomes one item; a
    playlist or whole podcast show (YouTube playlist, Bilibili 合集/系列, Apple
    Podcasts show, Xiaoyuzhou podcast) expands into a folder of episodes.
    Returns the queued items.
    """
    from app.pipeline.ingest import create_group_from_url, create_item_from_url
    from app.queue import enqueue_item

    out: list[dict] = []
    seen: set[int] = set()

    def _add(item: Item) -> None:
        if item.id in seen:
            return
        seen.add(item.id)
        enqueue_item(item.id)
        out.append(_brief(item))

    with session_scope() as session:
        for url in urls:
            group = create_group_from_url(session, url)
            if group is not None:
                for item in group[1]:
                    _add(item)
                continue
            _add(create_item_from_url(session, url))
    return out


@mcp.tool
def list_items(
    query: str | None = None,
    status: str | None = None,
    platform: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Search the library and return matching items (most recent first).

    Filters are optional: ``query`` matches the title, ``status`` is one of
    queued/fetching/transcribing/summarizing/done/error, ``platform`` is one of
    youtube/bilibili/apple_podcast/xiaoyuzhou/rss.
    """
    stmt = select(Item)
    if status:
        stmt = stmt.where(Item.status == status)
    if platform:
        stmt = stmt.where(Item.platform == platform)
    if query:
        stmt = stmt.where(col(Item.title).ilike(f"%{query}%"))
    stmt = stmt.order_by(col(Item.created_at).desc()).limit(min(max(limit, 1), 100))
    with session_scope() as session:
        return [_brief(item) for item in session.exec(stmt).all()]


@mcp.tool
def get_item(item_id: int) -> dict:
    """Get full details for one item, including the summary (markdown +
    structured TL;DR/outline/key points/quotes) and transcript availability."""
    with session_scope() as session:
        item = session.get(Item, item_id)
        if item is None:
            raise ValueError(f"item {item_id} not found")
        summary = session.exec(
            select(Summary).where(Summary.item_id == item_id)
        ).first()
        transcript = session.exec(
            select(Transcript).where(Transcript.item_id == item_id)
        ).first()
        data = _brief(item)
        data.update(
            {
                "description": item.description,
                "error": item.error,
                "view_count": item.view_count,
                "like_count": item.like_count,
                "total_cost_usd": item.total_cost_usd,
                "total_tokens": item.total_tokens,
                "has_transcript": transcript is not None,
                "transcript_language": transcript.language if transcript else None,
                "summary_markdown": summary.markdown if summary else None,
                "summary": summary.structured if summary else None,
            }
        )
        return data


def build_mcp_app() -> Starlette | None:
    """Return the MCP ASGI app to mount, or None when disabled."""
    if not get_settings().enable_mcp:
        return None
    return mcp.http_app(path="/")


if __name__ == "__main__":
    # Allow running as a local stdio MCP server too: `python -m app.mcp_server`.
    mcp.run()
