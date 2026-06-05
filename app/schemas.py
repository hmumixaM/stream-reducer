"""Pydantic request/response schemas for the REST API."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel

from app.models import ItemStatus, Platform, StageName, StageStatus, TranscriptSource


class AddItemRequest(BaseModel):
    # Either a single url or several. `url` may itself contain whitespace- or
    # newline-separated URLs (handled server-side).
    url: str | None = None
    urls: list[str] | None = None


class AddSubscriptionRequest(BaseModel):
    feed_url: str
    title: str | None = None
    interval_minutes: int | None = None


class StageRunRead(BaseModel):
    id: int
    stage: StageName
    status: StageStatus
    started_at: datetime
    finished_at: datetime | None
    duration_ms: int
    attempts: int
    provider: str | None
    model: str | None
    request_count: int
    chunk_count: int
    chunk_done: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    http_429_count: int
    error: str | None


class SummaryRead(BaseModel):
    id: int
    model: str
    prompt_version: str
    markdown: str
    structured: dict[str, Any]
    created_at: datetime


class TranscriptRead(BaseModel):
    id: int
    language: str | None
    source: TranscriptSource
    segments: list[dict[str, Any]]
    text: str


class ItemRead(BaseModel):
    id: int
    platform: Platform
    source_url: str
    external_id: str | None
    title: str | None
    author: str | None
    description: str | None
    duration_s: int | None
    published_at: datetime | None
    thumbnail: str | None
    view_count: int | None = None
    like_count: int | None = None
    dislike_count: int | None = None
    status: ItemStatus
    error: str | None
    subscription_id: int | None
    group_id: int | None = None
    group_position: int | None = None
    is_favorite: bool = False
    is_archived: bool = False
    media_bytes: int = 0
    audio_duration_s: float | None = None
    media_path: str | None = None
    enqueued_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    total_processing_ms: int
    total_api_requests: int
    total_tokens: int
    total_cost_usd: float
    retry_count: int
    created_at: datetime


class GroupRead(BaseModel):
    id: int
    platform: Platform
    external_id: str | None
    source_url: str
    title: str | None
    item_count: int
    created_at: datetime


class GroupCreate(BaseModel):
    title: str


class GroupUpdate(BaseModel):
    title: str


class ItemGroupAssign(BaseModel):
    """Move an item into a folder (group_id) or out of any folder (null)."""

    group_id: int | None = None


class CommentRead(BaseModel):
    id: int
    item_id: int
    body: str
    created_at: datetime


class CommentCreate(BaseModel):
    body: str


class ItemDetail(ItemRead):
    summary: SummaryRead | None = None
    transcript: TranscriptRead | None = None
    stages: list[StageRunRead] = []
    comments: list[CommentRead] = []


class QueueItemRead(ItemRead):
    current_stage: StageName | None = None
    chunk_done: int = 0
    chunk_count: int = 0


class SubscriptionRead(BaseModel):
    id: int
    platform: Platform
    feed_url: str
    title: str | None
    interval_minutes: int
    enabled: bool
    last_checked_at: datetime | None
    last_seen_guid: str | None
    created_at: datetime


class SettingsRead(BaseModel):
    llm_base_url: str
    # Effective (override-or-default) model selections.
    llm_model: str
    stt_model: str
    summary_map_model: str
    # Env defaults (shown when an override is active).
    llm_model_default: str
    stt_model_default: str
    summary_map_model_default: str
    # Curated suggestions for the UI (free text still allowed).
    llm_model_options: list[str]
    stt_model_options: list[str]
    transcribe_chunk_seconds: int
    transcribe_rate_limit: int
    default_language: str
    enable_gemini_audio_fallback: bool
    has_openrouter_key: bool
    has_llm_key: bool


class SettingsUpdate(BaseModel):
    """Runtime model overrides. Null/empty clears an override (back to default)."""

    llm_model: str | None = None
    stt_model: str | None = None
    summary_map_model: str | None = None


class PlatformStat(BaseModel):
    platform: str
    items: int
    done: int
    duration_s: float
    tokens: int
    cost_usd: float


class StatsRead(BaseModel):
    total_items: int
    items_by_status: dict[str, int]
    items_by_platform: dict[str, int]
    by_platform: list[PlatformStat] = []
    avg_stage_ms: dict[str, float]
    total_stage_ms: dict[str, float]
    cost_by_stage: dict[str, float] = {}
    # Source media + transcript volume
    total_duration_s: float = 0.0
    transcript_words: int = 0
    transcript_chars: int = 0
    # Token usage
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    openrouter_requests: int
    openrouter_tokens: int
    gemini_tokens: int
    total_cost_usd: float
    http_429_total: int
