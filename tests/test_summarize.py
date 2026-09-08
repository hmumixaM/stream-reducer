"""Unit tests for summary rendering and chunking (no network)."""

from __future__ import annotations

from app.models import Item, Platform
from app.pipeline.summarize import (
    _chunk_segments,
    fmt_timestamp,
    render_markdown,
    timestamp_link,
)


def test_fmt_timestamp():
    assert fmt_timestamp(95) == "01:35"
    assert fmt_timestamp(3661) == "01:01:01"
    assert fmt_timestamp(None) == ""


def test_timestamp_link_youtube():
    item = Item(platform=Platform.youtube, source_url="https://youtu.be/x?feature=1")
    link = timestamp_link(item, 90)
    assert "t=90s" in link and "[01:30]" in link


def test_timestamp_link_podcast():
    item = Item(platform=Platform.apple_podcast, source_url="https://x")
    assert timestamp_link(item, 90) == "`01:30`"


def test_chunk_segments_splits():
    segs = [{"start": i, "end": i + 1, "text": "word " * 50} for i in range(20)]
    chunks = _chunk_segments(segs, max_chars=500)
    assert len(chunks) > 1


def test_render_markdown():
    item = Item(
        platform=Platform.youtube,
        source_url="https://youtu.be/x",
        description="Original conference abstract.\nSpeaker: Ada",
    )
    structured = {
        "background": "Uploaded by Acme on YouTube; a talk about Python.",
        "tldr": "A talk.",
        "key_points": [{"text": "Point one", "timestamp": 30}],
        "outline": [{"title": "Intro", "start": 0, "summary": "opening"}],
        "quotes": [{"text": "hello", "timestamp": 10, "speaker": "A"}],
        "entities": ["Python"],
    }
    md = render_markdown(item, structured)
    assert "## Background" in md
    assert "Uploaded by Acme" in md
    assert "## TL;DR" in md
    assert "Point one" in md
    assert "t=30s" in md
    assert "Python" in md
    assert "## Video description" in md
    assert "Original conference abstract.\nSpeaker: Ada" in md
    assert structured["description"] == "Original conference abstract.\nSpeaker: Ada"
    assert "[Source]" in md


def test_build_context_includes_uploader_and_description():
    from app.pipeline.summarize import _build_context

    item = Item(
        platform=Platform.bilibili,
        source_url="https://b.com/x",
        title="T",
        author="马督工",
        description="2026年一季度财政数据分析。",
    )
    ctx = _build_context(item)
    assert "马督工" in ctx
    assert "财政数据分析" in ctx
    assert "Bilibili" in ctx
