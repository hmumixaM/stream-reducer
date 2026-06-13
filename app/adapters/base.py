"""Adapter contract and shared data structures."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


@dataclass
class ContentMeta:
    title: str | None = None
    author: str | None = None
    description: str | None = None
    duration_s: int | None = None
    published_at: datetime | None = None
    thumbnail: str | None = None
    external_id: str | None = None
    view_count: int | None = None
    like_count: int | None = None
    dislike_count: int | None = None
    # Channel/uploader id (used to derive the channel feed for prioritization).
    channel_id: str | None = None


@dataclass
class NativeTranscript:
    language: str | None = None
    # list of {"start": float, "end": float, "text": str}
    segments: list[dict] = field(default_factory=list)


class Adapter:
    """Base adapter. Subclasses implement metadata, transcript, and audio download."""

    name: str = "base"

    def fetch_metadata(self, url: str) -> ContentMeta:
        raise NotImplementedError

    def get_native_transcript(
        self, url: str, language: str | None = None
    ) -> NativeTranscript | None:
        return None

    def get_danmaku(self, url: str) -> list[dict] | None:
        """Optional timeline bullet-comments. Only Bilibili provides these."""
        return None

    def extract_entries(self, url: str) -> dict | None:
        """Expand a playlist/collection URL into entries. None when unsupported."""
        return None

    def download_audio(self, url: str, dest_dir: Path) -> Path:
        raise NotImplementedError
