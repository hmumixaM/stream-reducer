"""Aggregate processing/usage statistics for the dashboard."""

from __future__ import annotations

import re
from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlmodel import Session, func, select

from app.db import get_session
from app.models import Item, ItemStatus, StageName, StageRun, Transcript
from app.schemas import PlatformStat, StatsRead

router = APIRouter(prefix="/api/stats", tags=["stats"])

# Each CJK character counts as one "word"; each run of latin letters/digits as
# one word. A pragmatic word count for mixed Chinese/English transcripts.
_WORD_RE = re.compile(r"[\u4e00-\u9fff]|[0-9A-Za-z]+")


@router.get("", response_model=StatsRead)
def get_stats(session: Session = Depends(get_session)) -> StatsRead:
    total_items = session.exec(select(func.count()).select_from(Item)).one()

    by_status: dict[str, int] = defaultdict(int)
    for status, count in session.exec(
        select(Item.status, func.count()).group_by(Item.status)
    ).all():
        by_status[status.value] = count

    by_platform: dict[str, int] = defaultdict(int)
    for platform, count in session.exec(
        select(Item.platform, func.count()).group_by(Item.platform)
    ).all():
        by_platform[platform.value] = count

    avg_stage: dict[str, float] = {}
    total_stage: dict[str, float] = {}
    cost_by_stage: dict[str, float] = {}
    for stage, avg_ms, sum_ms, sum_cost in session.exec(
        select(
            StageRun.stage,
            func.avg(StageRun.duration_ms),
            func.sum(StageRun.duration_ms),
            func.sum(StageRun.cost_usd),
        ).group_by(StageRun.stage)
    ).all():
        avg_stage[stage.value] = float(avg_ms or 0)
        total_stage[stage.value] = float(sum_ms or 0)
        cost_by_stage[stage.value] = float(sum_cost or 0.0)

    def _sum(column, *stages: StageName) -> int:
        stmt = select(func.coalesce(func.sum(column), 0))
        if stages:
            stmt = stmt.where(StageRun.stage.in_([s for s in stages]))
        return int(session.exec(stmt).one() or 0)

    # --- Source media length + transcript volume ---
    total_duration_s = float(
        session.exec(select(func.coalesce(func.sum(Item.duration_s), 0))).one() or 0
    )
    transcript_words = 0
    transcript_chars = 0
    for text in session.exec(select(Transcript.text)).all():
        if text:
            transcript_chars += len(text)
            transcript_words += len(_WORD_RE.findall(text))

    # --- Per-platform detail (items + duration from Item, cost/tokens via join) ---
    platforms: dict[str, dict] = {}
    for platform, count, dur in session.exec(
        select(
            Item.platform,
            func.count(),
            func.coalesce(func.sum(Item.duration_s), 0),
        ).group_by(Item.platform)
    ).all():
        platforms[platform.value] = {
            "items": int(count or 0),
            "duration_s": float(dur or 0),
            "done": 0,
            "tokens": 0,
            "cost_usd": 0.0,
        }
    for platform, count in session.exec(
        select(Item.platform, func.count())
        .where(Item.status == ItemStatus.done)
        .group_by(Item.platform)
    ).all():
        if platform.value in platforms:
            platforms[platform.value]["done"] = int(count or 0)
    for platform, tokens, cost in session.exec(
        select(
            Item.platform,
            func.coalesce(func.sum(StageRun.total_tokens), 0),
            func.coalesce(func.sum(StageRun.cost_usd), 0.0),
        )
        .select_from(StageRun)
        .join(Item, StageRun.item_id == Item.id)
        .group_by(Item.platform)
    ).all():
        if platform.value in platforms:
            platforms[platform.value]["tokens"] = int(tokens or 0)
            platforms[platform.value]["cost_usd"] = float(cost or 0.0)
    by_platform_detail = [
        PlatformStat(platform=name, **data)
        for name, data in sorted(
            platforms.items(), key=lambda kv: kv[1]["items"], reverse=True
        )
    ]

    openrouter_requests = _sum(StageRun.request_count, StageName.transcribe)
    openrouter_tokens = _sum(StageRun.total_tokens, StageName.transcribe)
    gemini_tokens = _sum(StageRun.total_tokens, StageName.summarize, StageName.gemini_audio)
    http_429_total = _sum(StageRun.http_429_count)
    prompt_tokens = _sum(StageRun.prompt_tokens)
    completion_tokens = _sum(StageRun.completion_tokens)
    total_tokens = _sum(StageRun.total_tokens)
    total_cost = float(session.exec(
        select(func.coalesce(func.sum(StageRun.cost_usd), 0.0))
    ).one() or 0.0)

    return StatsRead(
        total_items=int(total_items or 0),
        items_by_status=dict(by_status),
        items_by_platform=dict(by_platform),
        by_platform=by_platform_detail,
        avg_stage_ms=avg_stage,
        total_stage_ms=total_stage,
        cost_by_stage=cost_by_stage,
        total_duration_s=total_duration_s,
        transcript_words=transcript_words,
        transcript_chars=transcript_chars,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        openrouter_requests=openrouter_requests,
        openrouter_tokens=openrouter_tokens,
        gemini_tokens=gemini_tokens,
        total_cost_usd=total_cost,
        http_429_total=http_429_total,
    )
