"""Stateless ingest -> transcribe -> summarize -> chunk orchestration.

Reuses the shared `app.adapters` (platform detection, metadata, native
transcripts, audio download) and `app.pipeline.audio` (ffmpeg) + prompt
templates, but holds no DB/queue state: it returns a JSON-serializable result
that the Worker persists to D1 / R2 / Vectorize.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import tempfile
import time

import httpx
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from app.adapters.base import ContentMeta
from app.adapters.registry import detect_platform, get_adapter
from app.pipeline.audio import decodable_duration, probe_duration, split_audio
from app.pipeline.jsonparse import extract_json
from app.pipeline.prompts import (
    DANMAKU_SYSTEM,
    DANMAKU_TEMPLATE,
    HEADLINE_TEMPLATE,
    KEY_POINTS_TEMPLATE,
    MAP_SYSTEM,
    MAP_TEMPLATE,
    OVERVIEW_TEMPLATE,
    QUOTES_ENTITIES_TEMPLATE,
    SECTION_SYSTEM,
    STRICT_JSON_SUFFIX,
    WALKTHROUGH_INDEX_TEMPLATE,
    INFOGRAPHIC_SYSTEM,
    INFOGRAPHIC_TEMPLATE,
    language_directive,
)
from app.zh import to_simplified

import llm

logger = logging.getLogger("pipeline")

# Tunables (env-overridable).
SUMMARY_CHUNK_CHARS = int(os.environ.get("SUMMARY_CHUNK_CHARS", "20000"))
SUMMARY_MAP_MAX_TOKENS = int(os.environ.get("SUMMARY_MAP_MAX_TOKENS", "8000"))
SUMMARY_REDUCE_MAX_TOKENS = int(os.environ.get("SUMMARY_REDUCE_MAX_TOKENS", "16000"))
SUMMARY_SECTION_SOURCE_CHARS = int(os.environ.get("SUMMARY_SECTION_SOURCE_CHARS", "50000"))
SUMMARY_INDEX_CHUNK_CHARS = int(os.environ.get("SUMMARY_INDEX_CHUNK_CHARS", "30000"))
SUMMARY_INDEX_MAX_TOKENS = int(os.environ.get("SUMMARY_INDEX_MAX_TOKENS", "6000"))
SUMMARY_HEADLINE_MAX_TOKENS = int(os.environ.get("SUMMARY_HEADLINE_MAX_TOKENS", "1200"))
TRANSCRIBE_CHUNK_SECONDS = int(os.environ.get("TRANSCRIBE_CHUNK_SECONDS", "300"))
EMBED_CHUNK_CHARS = int(os.environ.get("EMBED_CHUNK_CHARS", "1500"))
MEDIA_MAX_BYTES = int(os.environ.get("MEDIA_MAX_BYTES", str(25 * 1024 * 1024)))
PROMPT_VERSION = os.environ.get("SUMMARY_PROMPT_VERSION", "v2")
# Max danmaku (Bilibili bullet-comments) rendered into the mood-summary prompt.
DANMAKU_MAX_PROMPT_ITEMS = int(os.environ.get("DANMAKU_MAX_PROMPT_ITEMS", "3000"))
# Generous budget: gemini-flash spends tokens on thinking, and a tight cap left
# the completion empty (no JSON). Match the other reduce sections' headroom.
DANMAKU_MAX_TOKENS = int(os.environ.get("DANMAKU_MAX_TOKENS", "16000"))

PLATFORM_LABELS = {
    "youtube": "YouTube", "bilibili": "Bilibili", "apple_podcast": "Apple Podcasts",
    "xiaoyuzhou": "小宇宙", "rss": "RSS / web", "unknown": "web",
}
_TS_RE = re.compile(r"\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]")

# Substrings (case-insensitive) that mark content gated behind a channel
# membership / paid tier (YouTube members-only, Bilibili 充电专属/大会员, etc.).
# Such videos can't be downloaded with our cookies, so we exclude them (a
# terminal, non-retried state) instead of failing/retrying the item forever.
_MEMBERS_ONLY_MARKERS = (
    "members-only",
    "member's only",
    "join this channel",
    "available to this channel's members",
    "members of this channel",
    "subscriber_only",
    "needs_subscription",
    "premium_only",
    "充电专属",
    "充电视频",
    "专属视频",
    "大会员",
    "付费视频",
    "需要购买",
    "需要充电",
)


def _is_members_only(text: str) -> bool:
    t = (text or "").lower()
    return any(marker.lower() in t for marker in _MEMBERS_ONLY_MARKERS)


@dataclass
class ItemView:
    platform: str
    source_url: str
    title: str | None = None
    author: str | None = None
    description: str | None = None
    duration_s: int | None = None
    published_at: datetime | None = None
    view_count: int | None = None
    like_count: int | None = None


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


@dataclass
class Stage:
    stage: str
    provider: str | None = None
    model: str | None = None
    duration_ms: int = 0
    request_count: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    error: str | None = None
    _start: float = field(default=0.0, repr=False)

    def __enter__(self) -> "Stage":
        self._start = time.monotonic()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.duration_ms = int((time.monotonic() - self._start) * 1000)
        if exc_type is not None:
            self.error = f"{exc_type.__name__}: {exc}"[:2000]
        return False


# --- formatting helpers (ported from app.pipeline.summarize) --------------
def fmt_timestamp(seconds: float | None) -> str:
    if seconds is None:
        return ""
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def timestamp_link(item: ItemView, seconds: float | None) -> str:
    if seconds is None:
        return ""
    label = fmt_timestamp(seconds)
    if item.platform in ("youtube", "bilibili") and item.source_url:
        sep = "&" if "?" in item.source_url else "?"
        return f"[{label}]({item.source_url}{sep}t={int(seconds)}s)"
    return f"`{label}`"


def strip_body_timestamps(text: str) -> str:
    out: list[str] = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            out.append(line)
            continue
        cleaned = _TS_RE.sub("", line)
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
        cleaned = re.sub(r"\s+([，。、！？；：）),.!?;:])", r"\1", cleaned)
        out.append(cleaned.rstrip())
    return "\n".join(out)


def linkify_timestamps(item: ItemView, text: str) -> str:
    def repl(m: re.Match) -> str:
        total = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        return timestamp_link(item, total)

    return _TS_RE.sub(repl, text)


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text


def _build_context(item: ItemView) -> str:
    lines = [
        f"- Title: {item.title or '(unknown)'}",
        f"- Platform: {PLATFORM_LABELS.get(item.platform, item.platform)}",
        f"- Channel / author: {item.author or '(unknown)'}",
    ]
    if item.published_at:
        lines.append(f"- Published: {item.published_at.date().isoformat()}")
    if item.duration_s:
        lines.append(f"- Duration: {fmt_timestamp(item.duration_s)}")
    if item.view_count is not None:
        lines.append(f"- View count: {item.view_count:,}")
    if item.like_count is not None:
        lines.append(f"- Like count: {item.like_count:,}")
    lines.append(f"- Source URL: {item.source_url}")
    desc = (item.description or "").strip()
    if desc:
        if len(desc) > 4000:
            desc = desc[:4000] + " …"
        lines.append(f"- Show notes / description:\n{desc}")
    else:
        lines.append("- Show notes / description: (none provided)")
    return "\n".join(lines)


def _chunk_segments(segments: list[dict], max_chars: int) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for seg in segments:
        ts = fmt_timestamp(seg.get("start"))
        line = f"[{ts}] {(seg.get('text') or '').strip()}"
        if size + len(line) > max_chars and current:
            chunks.append("\n".join(current))
            current = []
            size = 0
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def render_markdown(item: ItemView, structured: dict) -> str:
    lines: list[str] = []
    if structured.get("background"):
        lines += ["## Background", structured["background"], ""]
    if structured.get("tldr"):
        lines += ["## TL;DR", structured["tldr"], ""]
    if structured.get("atmosphere"):
        lines += ["## Atmosphere & style", structured["atmosphere"], ""]
    for kp in structured.get("key_points") or []:
        if lines and lines[-1] != "## Key takeaways":
            if "## Key takeaways" not in lines:
                lines += ["## Key takeaways"]
        link = timestamp_link(item, kp.get("timestamp"))
        prefix = f"{link} " if link else ""
        lines.append(f"- {prefix}{kp.get('text', '')}")
    if structured.get("key_points"):
        lines.append("")
    if structured.get("walkthrough"):
        lines += ["## Detailed walkthrough", linkify_timestamps(item, structured["walkthrough"]).strip(), ""]
    for q in structured.get("quotes") or []:
        if "## Notable quotes" not in lines:
            lines += ["## Notable quotes"]
        link = timestamp_link(item, q.get("timestamp"))
        speaker = q.get("speaker")
        who = f" — {speaker}" if speaker else ""
        prefix = f"{link} " if link else ""
        lines += [f"> {prefix}{q.get('text', '')}{who}", ""]
    if structured.get("entities"):
        lines += ["## Mentioned", ", ".join(str(e) for e in structured["entities"]), ""]
    danmaku = structured.get("danmaku")
    if isinstance(danmaku, dict):
        lines += render_danmaku_markdown(danmaku)
    if item.source_url:
        lines.append(f"[Source]({item.source_url})")
    return "\n".join(lines).strip()


def render_danmaku_markdown(danmaku: dict) -> list[str]:
    """Render the Bilibili 弹幕 (audience mood) summary block (ported from the
    legacy local pipeline). Returns markdown lines appended to the report."""
    lines: list[str] = []
    count = danmaku.get("count")
    header = "## 弹幕氛围 (Danmaku mood)"
    if count:
        header += f" — {count} 条"
    lines.append(header)

    mood = danmaku.get("overall_mood")
    if mood:
        lines += [mood, ""]

    sentiment = danmaku.get("sentiment") or {}
    if sentiment:
        pos = sentiment.get("positive", 0)
        neu = sentiment.get("neutral", 0)
        neg = sentiment.get("negative", 0)
        lines += [f"**整体情绪**：😊 正面 {pos}% · 😐 中性 {neu}% · 😞 负面 {neg}%", ""]

    themes = danmaku.get("themes") or []
    if themes:
        lines.append("**热议点**")
        for t in themes:
            topic = t.get("topic", "") if isinstance(t, dict) else str(t)
            example = t.get("example") if isinstance(t, dict) else None
            tail = f" —— “{example}”" if example else ""
            lines.append(f"- **{topic}**{tail}")
        lines.append("")

    highlights = danmaku.get("highlights") or []
    if highlights:
        lines.append("**代表弹幕**")
        for h in highlights:
            lines += [f"> {h}", ""]

    return lines


# --- metadata --------------------------------------------------------------
def _meta_to_dict(meta: ContentMeta) -> dict:
    return {
        "title": to_simplified(meta.title or "") or None,
        "author": to_simplified(meta.author or "") or None,
        "description": to_simplified(meta.description or "") or None,
        "duration_s": meta.duration_s,
        "published_at": meta.published_at.isoformat() if meta.published_at else None,
        "thumbnail": meta.thumbnail,
        "external_id": meta.external_id,
        "view_count": meta.view_count,
        "like_count": meta.like_count,
        "dislike_count": meta.dislike_count,
        "channel_id": meta.channel_id,
    }


def _apply_bilibili_cookie(cookie: str | None) -> None:
    """Override the container's BILIBILI_COOKIE with the per-job (auto-refreshed)
    cookie passed by the Worker, and drop any cookie file materialized from the
    previous value so the adapter re-materializes the new one."""
    if not cookie:
        return
    if os.environ.get("BILIBILI_COOKIE") != cookie:
        os.environ["BILIBILI_COOKIE"] = cookie
        from app.adapters.ytdlp_base import reset_cookie_cache

        reset_cookie_cache()


def fetch_metadata(source_url: str, platform: str | None = None, bilibili_cookie: str | None = None) -> dict:
    _apply_bilibili_cookie(bilibili_cookie)
    # A cold container serves requests before WARP finishes its handshake (it
    # warms in the background), so yt-dlp's first proxied call would otherwise
    # hit "[Errno 111] Connection refused". Block (bounded) until WARP is ready.
    from app.adapters.ytdlp_base import await_warp_ready
    await_warp_ready()
    # The adapter registry is keyed by the Platform enum; always resolve it from
    # the URL (the string `platform` from the Worker is informational only).
    adapter = get_adapter(detect_platform(source_url))
    meta = adapter.fetch_metadata(source_url)
    return _meta_to_dict(meta)


def fetch_feed_entries(source_url: str, limit: int = 300) -> dict:
    """Enumerate a channel/playlist's recent uploads (newest first) for
    subscription polling. Routed through the container because the Worker can't
    run yt-dlp and a channel's RSS feed is capped at its latest ~15 uploads.
    """
    # Wait for WARP before the first proxied yt-dlp call so a cold container
    # doesn't fail with "[Errno 111] Connection refused" (see fetch_metadata).
    from app.adapters.ytdlp_base import await_warp_ready
    await_warp_ready()
    adapter = get_adapter(detect_platform(source_url))
    extract = getattr(adapter, "extract_feed_entries", None)
    return {"entries": extract(source_url, limit) if extract else []}


# --- chunking for embeddings ----------------------------------------------
def _hash(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


def _chunk_for_embed(transcript: dict | None, structured: dict, markdown: str) -> list[dict]:
    chunks: list[dict] = []
    idx = 0
    if transcript and transcript.get("segments"):
        buf: list[str] = []
        start = None
        size = 0
        for seg in transcript["segments"]:
            if start is None:
                start = seg.get("start")
            buf.append((seg.get("text") or "").strip())
            size += len(seg.get("text") or "")
            end = seg.get("end")
            if size >= EMBED_CHUNK_CHARS:
                text = " ".join(buf).strip()
                if text:
                    chunks.append({"source": "transcript", "field": "transcript", "chunk_index": idx,
                                   "text": text, "start_s": start, "end_s": end, "char_start": None,
                                   "char_end": None, "content_hash": _hash(text)})
                    idx += 1
                buf, start, size = [], None, 0
        if buf:
            text = " ".join(buf).strip()
            if text:
                chunks.append({"source": "transcript", "field": "transcript", "chunk_index": idx,
                               "text": text, "start_s": start, "end_s": None, "char_start": None,
                               "char_end": None, "content_hash": _hash(text)})
                idx += 1

    # Summary paragraphs (these become knowledge-graph nodes).
    for field_name in ("background", "tldr", "atmosphere"):
        val = structured.get(field_name)
        if isinstance(val, str) and val.strip():
            chunks.append({"source": "summary", "field": field_name, "chunk_index": idx,
                           "text": val.strip(), "start_s": None, "end_s": None, "char_start": None,
                           "char_end": None, "content_hash": _hash(val)})
            idx += 1
    for kp in structured.get("key_points") or []:
        text = (kp.get("text") if isinstance(kp, dict) else str(kp)) or ""
        if text.strip():
            chunks.append({"source": "summary", "field": "key_point", "chunk_index": idx,
                           "text": text.strip(), "start_s": None, "end_s": None, "char_start": None,
                           "char_end": None, "content_hash": _hash(text)})
            idx += 1
    walkthrough = structured.get("walkthrough") or ""
    for para in [p for p in re.split(r"\n{2,}", walkthrough) if len(p.strip()) > 80]:
        chunks.append({"source": "summary", "field": "walkthrough", "chunk_index": idx,
                       "text": para.strip()[:1500], "start_s": None, "end_s": None, "char_start": None,
                       "char_end": None, "content_hash": _hash(para)})
        idx += 1
    return chunks


# Target-language directives for on-demand translations. The summary is
# re-generated from the transcript with the output language enforced.
_LANG_NAMES = {
    "en": "English", "ja": "Japanese (日本語)", "ko": "Korean (한국어)",
    "es": "Spanish", "fr": "French", "de": "German", "ru": "Russian",
}


def target_language_directive(code: str) -> str:
    if code == "zh":
        from app.pipeline.prompts import LANGUAGE_SIMPLIFIED_CHINESE
        return LANGUAGE_SIMPLIFIED_CHINESE
    name = _LANG_NAMES.get(code, code)
    return (
        f"Write ALL text fields in {name}, translating faithfully from the source. "
        f"Render the entire summary natively in {name}; do not mix in the source language "
        f"for narration. You may keep widely-used proper nouns, product names, and "
        f"technical acronyms in their original form where natural."
    )


def _language_setup(transcript_text: str, target_lang: str | None) -> tuple[str, str, str]:
    map_system = MAP_SYSTEM
    section_system = SECTION_SYSTEM
    if target_lang:
        lang = target_language_directive(target_lang)
        # The system prompts default to "write in the SAME language as the
        # transcript", which would otherwise win over the per-request language.
        # Append an explicit override so the model translates to the target.
        name = "简体中文 (Simplified Chinese)" if target_lang == "zh" else _LANG_NAMES.get(target_lang, target_lang)
        override = (
            f" CRITICAL LANGUAGE OVERRIDE: Disregard any earlier instruction to keep the source language. "
            f"You MUST write ALL prose and text fields in {name}, fully translating from the source "
            f"(JSON keys stay in English). This language requirement takes absolute priority."
        )
        map_system += override
        section_system += override
    else:
        lang = language_directive(transcript_text)
    return lang, map_system, section_system


def _chunk_text(text: str, max_chars: int) -> list[str]:
    paragraphs = re.split(r"\n{2,}", text)
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if size + len(para) > max_chars and current:
            chunks.append("\n\n".join(current))
            current = []
            size = 0
        current.append(para)
        size += len(para) + 2
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def _format_index_part(data: dict, part: int) -> str:
    lines = [f"### Compact source index part {part}"]
    topics = data.get("topics") if isinstance(data.get("topics"), list) else []
    for topic in topics:
        if not isinstance(topic, dict):
            continue
        ts = topic.get("timestamp")
        label = f"[{fmt_timestamp(ts)}] " if isinstance(ts, (int, float)) else ""
        heading = str(topic.get("heading") or "Topic").strip()
        claims = topic.get("claims") if isinstance(topic.get("claims"), list) else []
        clean_claims = [str(c).strip() for c in claims if str(c).strip()]
        suffix = "; ".join(clean_claims)
        lines.append(f"- {label}{heading}: {suffix}" if suffix else f"- {label}{heading}")
    quotes = data.get("quotes") if isinstance(data.get("quotes"), list) else []
    for quote in quotes:
        if not isinstance(quote, dict) or not quote.get("text"):
            continue
        ts = quote.get("timestamp")
        label = f"[{fmt_timestamp(ts)}] " if isinstance(ts, (int, float)) else ""
        speaker = f" — {quote.get('speaker')}" if quote.get("speaker") else ""
        lines.append(f"> {label}{quote.get('text')}{speaker}")
    entities = data.get("entities") if isinstance(data.get("entities"), list) else []
    if entities:
        lines.append("Entities: " + ", ".join(str(e) for e in entities if str(e).strip()))
    return "\n".join(lines)


def _generate_json_section(
    st: Stage,
    prompt: str,
    system: str,
    defaults: dict,
    max_tokens: int,
    deadline: float | None = None,
) -> dict:
    # Total summarize budget guard: once we're past the deadline, stop making
    # calls and use defaults so summarize can't overrun the worker's stream
    # budget (which left items stuck in 'summarizing').
    if deadline is not None and time.monotonic() > deadline:
        logger.warning("summarize budget exceeded; skipping section")
        return defaults.copy()
    for attempt in range(2):
        section_system = system if attempt == 0 else system + STRICT_JSON_SUFFIX
        try:
            res = llm.generate_text(prompt, system=section_system, max_tokens=max_tokens)
        except httpx.HTTPError as exc:
            # Timeout / proxy error / 5xx: fall back to defaults immediately (no
            # second attempt, which would likely stall again) so one bad section
            # can't overrun the worker budget and leave the item stuck.
            logger.warning("summary section LLM call failed: %s", exc)
            break
        st.request_count += 1
        st.total_tokens += res.total_tokens
        try:
            data = extract_json(res.text)
            return {**defaults, **data}
        except (json.JSONDecodeError, ValueError):
            continue
    return defaults.copy()


def _build_walkthrough_index(item: ItemView, walkthrough: str, lang: str, section_system: str, st: Stage, deadline: float | None = None) -> str:
    parts = _chunk_text(walkthrough, SUMMARY_INDEX_CHUNK_CHARS)
    if not parts:
        return walkthrough
    index_parts: list[str] = []
    defaults = {"topics": [], "quotes": [], "entities": []}
    for i, part in enumerate(parts, start=1):
        prompt = WALKTHROUGH_INDEX_TEMPLATE.format(
            context=_build_context(item),
            index=i,
            total=len(parts),
            source=part,
            language_instruction=lang,
        )
        data = _generate_json_section(st, prompt, section_system, defaults, SUMMARY_INDEX_MAX_TOKENS, deadline)
        if data != defaults:
            index_parts.append(_format_index_part(data, i))
    return "\n\n".join(index_parts) if index_parts else walkthrough[:SUMMARY_SECTION_SOURCE_CHARS]


def _structured_to_source_notes(structured: dict) -> str:
    lines: list[str] = []
    for heading, key in (
        ("Background", "background"),
        ("TL;DR", "tldr"),
        ("Atmosphere", "atmosphere"),
    ):
        value = structured.get(key)
        if isinstance(value, str) and value.strip():
            lines += [f"## {heading}", value.strip(), ""]
    key_points = structured.get("key_points") if isinstance(structured.get("key_points"), list) else []
    if key_points:
        lines.append("## Key points")
        for kp in key_points:
            text = kp.get("text") if isinstance(kp, dict) else str(kp)
            if text:
                lines.append(f"- {text}")
        lines.append("")
    quotes = structured.get("quotes") if isinstance(structured.get("quotes"), list) else []
    if quotes:
        lines.append("## Quotes")
        for quote in quotes:
            text = quote.get("text") if isinstance(quote, dict) else str(quote)
            if text:
                lines.append(f"> {text}")
    return "\n".join(lines).strip()


def _generate_structured_sections(
    item: ItemView,
    source: str,
    stages: list[Stage],
    lang: str,
    section_system: str,
    existing: dict | None = None,
    walkthrough: str | None = None,
    active_stage: Stage | None = None,
    deadline: float | None = None,
    on_progress=None,
) -> dict:
    existing = existing or {}

    def _emit(detail: str) -> None:
        if on_progress:
            try:
                on_progress({"stage": "summarize", "detail": detail})
            except Exception:  # noqa: BLE001
                pass

    def build(st: Stage) -> dict:
        compact_source = source
        if len(source) > SUMMARY_SECTION_SOURCE_CHARS:
            _emit("index")
            compact_source = _build_walkthrough_index(item, source, lang, section_system, st, deadline)
        quote_source = source if len(source) <= SUMMARY_SECTION_SOURCE_CHARS else compact_source
        context = _build_context(item)

        _emit("overview")
        overview = _generate_json_section(
            st,
            OVERVIEW_TEMPLATE.format(context=context, source=compact_source, language_instruction=lang),
            section_system,
            {"background": "", "tldr": "", "atmosphere": ""},
            SUMMARY_REDUCE_MAX_TOKENS,
            deadline,
        )
        _emit("key points")
        key_points = _generate_json_section(
            st,
            KEY_POINTS_TEMPLATE.format(context=context, source=compact_source, language_instruction=lang),
            section_system,
            {"key_points": []},
            SUMMARY_REDUCE_MAX_TOKENS,
            deadline,
        )
        _emit("quotes")
        quotes_entities = _generate_json_section(
            st,
            QUOTES_ENTITIES_TEMPLATE.format(context=context, source=quote_source, language_instruction=lang),
            section_system,
            {"quotes": [], "entities": []},
            SUMMARY_REDUCE_MAX_TOKENS,
            deadline,
        )
        _emit("headline")
        headline = _generate_json_section(
            st,
            HEADLINE_TEMPLATE.format(context=context, source=compact_source, language_instruction=lang),
            section_system,
            {"headline": "", "subhead": ""},
            SUMMARY_HEADLINE_MAX_TOKENS,
            deadline,
        )

        preserved_walkthrough = walkthrough if walkthrough is not None else existing.get("walkthrough", "")
        return {
            "background": overview.get("background") or existing.get("background", ""),
            "tldr": overview.get("tldr") or existing.get("tldr", ""),
            "atmosphere": overview.get("atmosphere") or existing.get("atmosphere", ""),
            "key_points": key_points.get("key_points") or existing.get("key_points", []),
            "quotes": quotes_entities.get("quotes") or existing.get("quotes", []),
            "entities": quotes_entities.get("entities") or existing.get("entities", []),
            "headline": headline.get("headline") or existing.get("headline", ""),
            "subhead": headline.get("subhead") or existing.get("subhead", ""),
            "walkthrough": preserved_walkthrough,
            # Preserve the Bilibili 弹幕 mood block across structured backfills.
            **({"danmaku": existing["danmaku"]} if existing.get("danmaku") else {}),
        }

    if active_stage is not None:
        return build(active_stage)
    with Stage("summarize", provider="gemini", model=os.environ.get("GEMINI_MODEL")) as st:
        structured = build(st)
    stages.append(st)
    return structured


def _build_infographic_prompt(item: ItemView, structured: dict, lang: str) -> str:
    def _points() -> str:
        out: list[str] = []
        for kp in (structured.get("key_points") or [])[:8]:
            text = (kp.get("text") if isinstance(kp, dict) else str(kp)) or ""
            if text.strip():
                out.append(f"- {text.strip()}")
        return "\n".join(out) or "(none)"

    def _quotes() -> str:
        out: list[str] = []
        for q in (structured.get("quotes") or [])[:3]:
            text = (q.get("text") if isinstance(q, dict) else str(q)) or ""
            who = q.get("speaker") if isinstance(q, dict) else None
            if text.strip():
                out.append(f"- \"{text.strip()}\"" + (f" — {who}" if who else ""))
        return "\n".join(out) or "(none)"

    entities = structured.get("entities") or []
    return INFOGRAPHIC_TEMPLATE.format(
        context=_build_context(item),
        headline=structured.get("headline") or item.title or "(untitled)",
        subhead=structured.get("subhead") or "",
        tldr=structured.get("tldr") or "",
        key_points=_points(),
        quotes=_quotes(),
        entities=", ".join(str(e) for e in entities) or "(none)",
        language_instruction=lang,
    )


def generate_infographic(item: ItemView, structured: dict, stages: list[Stage]) -> dict:
    # Render the poster in whatever language the summary is written in.
    sample = " ".join(
        str(structured.get(k) or "") for k in ("headline", "subhead", "tldr")
    ).strip()
    lang = language_directive(sample)
    prompt = _build_infographic_prompt(item, structured, lang)

    with Stage("infographic", provider="gemini", model=llm._image_model()) as st:
        res = llm.generate_image(prompt, system=INFOGRAPHIC_SYSTEM)
        st.request_count += 1
        st.total_tokens += res.total_tokens
        st.cost_usd += res.cost_usd
    stages.append(st)
    return {
        "image_b64": res.image_b64,
        "mime_type": res.mime_type,
        "model": res.model,
        "total_tokens": res.total_tokens,
        "cost_usd": res.cost_usd,
    }


# --- summarize -------------------------------------------------------------
def summarize(item: ItemView, transcript: dict, stages: list[Stage], target_lang: str | None = None, on_progress=None) -> dict:
    def emit(detail: str) -> None:
        if on_progress:
            try:
                on_progress({"stage": "summarize", "detail": detail})
            except Exception:  # noqa: BLE001
                pass

    segments = transcript.get("segments") or []
    chunks = _chunk_segments(segments, SUMMARY_CHUNK_CHARS)
    lang, map_system, section_system = _language_setup(transcript.get("text") or "", target_lang)
    logger.info("summarize start: %d segments, %d map chunks, transcript=%d chars",
                len(segments), len(chunks), len(transcript.get("text") or ""))

    # Hard wall-clock budget for the whole summarize stage so it can't overrun
    # the worker's ~15min stream budget and leave the item stuck in 'summarizing'.
    deadline = time.monotonic() + float(os.environ.get("SUMMARIZE_BUDGET", "480"))
    with Stage("summarize", provider="gemini", model=os.environ.get("GEMINI_MODEL")) as st:
        note_blocks: list[str] = []
        for i, chunk in enumerate(chunks, start=1):
            emit(f"notes {i}/{len(chunks)}")
            if time.monotonic() > deadline:
                logger.warning("summarize budget exceeded at map chunk %d/%d; using partial", i, len(chunks))
                break
            try:
                res = llm.generate_text(
                    MAP_TEMPLATE.format(index=i, total=len(chunks), chunk=chunk, language_instruction=lang),
                    system=map_system, max_tokens=SUMMARY_MAP_MAX_TOKENS,
                )
            except httpx.HTTPError as exc:
                # A stalled/failed map call shouldn't hang the whole job; skip
                # this chunk's notes (best-effort) rather than overrun the budget.
                logger.warning("summary map chunk %d/%d LLM call failed: %s", i, len(chunks), exc)
                continue
            st.request_count += 1
            st.total_tokens += res.total_tokens
            note_blocks.append(strip_body_timestamps(_strip_fences(res.text).strip()))
        walkthrough = "\n\n".join(note_blocks)
        logger.info("summarize: map done (%d/%d notes, %d chars), generating structured sections",
                    len(note_blocks), len(chunks), len(walkthrough))
        structured = _generate_structured_sections(
            item,
            walkthrough,
            stages,
            lang,
            section_system,
            walkthrough=walkthrough,
            active_stage=st,
            deadline=deadline,
            on_progress=emit,
        )
    logger.info("summarize done: %d requests, %d tokens, %dms",
                st.request_count, st.total_tokens, st.duration_ms)
    stages.append(st)
    return structured


def _render_danmaku_list(items: list[dict]) -> str:
    out: list[str] = []
    for d in items[:DANMAKU_MAX_PROMPT_ITEMS]:
        out.append(f"[{fmt_timestamp(d.get('time'))}] {d.get('text', '')}")
    return "\n".join(out)


def summarize_danmaku(items: list[dict], stages: list[Stage]) -> dict | None:
    """Characterize the audience mood from Bilibili 弹幕 in one LLM call. Returns
    {overall_mood, sentiment, themes, highlights, count} or None. Best-effort:
    never raises (danmaku are optional and must not fail the item)."""
    if not items:
        return None
    prompt = DANMAKU_TEMPLATE.format(count=len(items), danmaku=_render_danmaku_list(items))
    with Stage("danmaku", provider="gemini", model=os.environ.get("GEMINI_MODEL")) as st:
        data = None
        try:
            res = llm.generate_text(prompt, system=DANMAKU_SYSTEM, max_tokens=DANMAKU_MAX_TOKENS)
            st.request_count += 1
            st.total_tokens += res.total_tokens
            try:
                data = extract_json(res.text)
            except (json.JSONDecodeError, ValueError) as exc:
                logger.warning("danmaku summarize unparseable (%s): completion=%r",
                               exc, (res.text or "")[:300])
        except httpx.HTTPError as exc:
            logger.warning("danmaku summarize LLM call failed: %s", exc)
    stages.append(st)
    if not isinstance(data, dict):
        return None
    data["count"] = len(items)
    logger.info("danmaku summarized: %d comments, %d tokens", len(items), st.total_tokens)
    return data


def regenerate_structured(
    item: ItemView,
    existing: dict,
    stages: list[Stage],
    target_lang: str | None = None,
) -> dict:
    source = existing.get("walkthrough") if isinstance(existing.get("walkthrough"), str) else ""
    if not source.strip():
        source = _structured_to_source_notes(existing)
    if not source.strip():
        source = _build_context(item)
    lang, _, section_system = _language_setup(source, target_lang)
    structured = _generate_structured_sections(
        item,
        source,
        stages,
        lang,
        section_system,
        existing=existing,
        walkthrough=existing.get("walkthrough", ""),
    )
    return structured


def regenerate_headline(
    item: ItemView,
    existing: dict,
    stages: list[Stage],
    target_lang: str | None = None,
) -> dict:
    """Re-generate only the headline/subhead from an existing summary.

    Cheap (one LLM call): reuses the stored walkthrough (or the structured notes
    when no walkthrough exists) instead of re-running the full structured set.
    """
    source = existing.get("walkthrough") if isinstance(existing.get("walkthrough"), str) else ""
    if not source.strip():
        source = _structured_to_source_notes(existing)
    if not source.strip():
        source = _build_context(item)
    lang, _, section_system = _language_setup(source, target_lang)
    with Stage("summarize", provider="gemini", model=os.environ.get("GEMINI_MODEL")) as st:
        compact_source = source
        if len(source) > SUMMARY_SECTION_SOURCE_CHARS:
            compact_source = _build_walkthrough_index(item, source, lang, section_system, st)
        headline = _generate_json_section(
            st,
            HEADLINE_TEMPLATE.format(context=_build_context(item), source=compact_source, language_instruction=lang),
            section_system,
            {"headline": "", "subhead": ""},
            SUMMARY_HEADLINE_MAX_TOKENS,
        )
    stages.append(st)
    out = dict(existing)
    out["headline"] = headline.get("headline") or existing.get("headline", "")
    out["subhead"] = headline.get("subhead") or existing.get("subhead", "")
    return out


def _apply_supplied_metadata(item: ItemView, supplied: dict) -> None:
    item.title = supplied.get("title")
    item.author = supplied.get("author")
    item.description = supplied.get("description")
    item.duration_s = supplied.get("duration_s")
    item.published_at = _parse_dt(supplied.get("published_at"))
    item.view_count = supplied.get("view_count")
    item.like_count = supplied.get("like_count")


def _excluded_result(metadata: dict, stages: list[Stage], message: str) -> dict:
    """Terminal result for content we deliberately don't download (e.g.
    members-only / paid). The Worker flips the item to an 'excluded' status
    (not an error, not retried)."""
    return {
        "metadata": metadata or {},
        "transcript": None,
        "summary": None,
        "chunks": [],
        "media": {"bytes": 0, "duration_s": None, "audio_b64": None, "format": None},
        "stages": [_stage_dict(s) for s in stages],
        "error": message,
        "excluded": True,
    }


# --- top-level run ---------------------------------------------------------
def run(job: dict, on_progress=None) -> dict:
    source_url = job["source_url"]
    _apply_bilibili_cookie(job.get("bilibili_cookie"))
    plat = detect_platform(source_url)  # Platform enum (registry key)
    mode = job.get("mode", "process")
    stages: list[Stage] = []

    def emit(evt: dict) -> None:
        if on_progress:
            try:
                on_progress(evt)
            except Exception:  # noqa: BLE001 — progress reporting must never break the job
                pass

    target_lang = job.get("target_lang") or None
    # Stored metadata from the Worker (feed title/show notes/date/views). Used as
    # a fallback so RSS/podcast items — whose audio URL exposes no scrapeable
    # metadata — still get real summary context.
    supplied = job.get("item") or {}
    item = ItemView(platform=plat.value, source_url=source_url)
    if supplied:
        _apply_supplied_metadata(item, supplied)
    metadata: dict = {}
    transcript: dict | None = job.get("transcript")
    media = {"bytes": 0, "duration_s": None, "audio_b64": None, "format": None}
    danmaku: list[dict] = []  # Bilibili bullet-comments (audience mood); optional.

    if mode == "infographic":
        existing = job.get("summary") or {}
        infographic = generate_infographic(item, existing, stages)
        return {
            "metadata": metadata,
            "transcript": None,
            "summary": None,
            "infographic": infographic,
            "chunks": [],
            "media": media,
            "stages": [_stage_dict(s) for s in stages],
            "error": None,
        }

    if mode in ("structured_backfill", "headline_backfill"):
        existing = job.get("summary") or {}
        if mode == "headline_backfill":
            structured = regenerate_headline(item, existing, stages, target_lang=target_lang)
        else:
            structured = regenerate_structured(item, existing, stages, target_lang=target_lang)
        markdown = render_markdown(item, structured)
        return {
            "metadata": metadata,
            "transcript": None,
            "summary": {
                "model": os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"),
                "prompt_version": PROMPT_VERSION,
                "markdown": markdown,
                "structured": structured,
            },
            "chunks": [],
            "media": media,
            "stages": [_stage_dict(s) for s in stages],
            "error": None,
        }

    adapter = get_adapter(plat)

    if mode != "resummarize":
        try:
            with tempfile.TemporaryDirectory(prefix="sr_media_") as tmp:
                emit({"stage": "download", "status": "start"})
                # Cold containers warm WARP in the background; wait briefly so the
                # first egress (metadata fetch) doesn't race the WireGuard handshake.
                from app.adapters.ytdlp_base import await_warp_ready

                await_warp_ready()
                with Stage("download", provider=adapter.name) as st:
                    meta = adapter.fetch_metadata(source_url)
                    metadata = _meta_to_dict(meta)
                    # Adapter-scraped metadata wins when present; fall back to the
                    # stored feed metadata (the only source for podcast enclosures).
                    item.title = metadata["title"] or supplied.get("title")
                    item.author = metadata["author"] or supplied.get("author")
                    item.description = metadata["description"] or supplied.get("description")
                    item.duration_s = metadata["duration_s"] or supplied.get("duration_s")
                    item.published_at = meta.published_at or _parse_dt(supplied.get("published_at"))
                    item.view_count = metadata.get("view_count") or supplied.get("view_count")
                    item.like_count = metadata.get("like_count") or supplied.get("like_count")

                    # Bilibili 弹幕 (audience bullet-comments) for a separate mood
                    # summary. Best-effort: [] for non-bilibili or on any error.
                    danmaku = adapter.get_danmaku(source_url) or []
                    logger.info("danmaku fetched: %d items for %s", len(danmaku), source_url)
                    if danmaku:
                        emit({"stage": "download", "detail": f"{len(danmaku)} 弹幕"})

                    native = adapter.get_native_transcript(source_url, os.environ.get("DEFAULT_LANGUAGE") or None)
                    if native and native.segments:
                        segs = [{**s, "text": to_simplified(s.get("text", ""))} for s in native.segments]
                        transcript = {"language": native.language, "source": "native", "segments": segs,
                                      "text": "\n".join(s.get("text", "") for s in segs)}
                    else:
                        audio_path = Path(adapter.download_audio(source_url, Path(tmp), on_progress=emit))
                        decodable = decodable_duration(audio_path)
                        media["bytes"] = audio_path.stat().st_size
                        media["duration_s"] = decodable or probe_duration(audio_path)
                        media["format"] = audio_path.suffix.lstrip(".") or "mp3"
                        if media["bytes"] <= MEDIA_MAX_BYTES:
                            media["audio_b64"] = base64.b64encode(audio_path.read_bytes()).decode("ascii")
                stages.append(st)

                if transcript is None:
                    emit({"stage": "transcribe", "status": "start"})
                    transcript = _transcribe(tmp, audio_path, stages, on_progress=emit)

                # Stream the metadata + transcript as soon as they're ready so the
                # UI shows them WHILE summarize runs (and you can immediately see
                # whether the transcript came back empty before it summarizes).
                emit({"partial": "transcript", "metadata": metadata, "transcript": transcript})
        except Exception as exc:  # noqa: BLE001
            # Membership/paid-gated videos (YouTube members-only, Bilibili
            # 充电专属, …) can't be downloaded — exclude them so they aren't
            # retried forever or surfaced as failures.
            if _is_members_only(str(exc)):
                return _excluded_result(metadata, stages, f"{type(exc).__name__}: {exc}")
            raise
    else:
        # resummarize / translate: reuse provided transcript. Prefer metadata
        # passed by the caller (avoids a re-fetch — important for sources like
        # Bilibili that block our egress); fall back to fetching otherwise.
        if supplied:
            _apply_supplied_metadata(item, supplied)
        else:
            meta = adapter.fetch_metadata(source_url)
            metadata = _meta_to_dict(meta)
            item.title = metadata["title"]
            item.author = metadata["author"]
            item.description = metadata["description"]
            item.duration_s = metadata["duration_s"]
            item.published_at = meta.published_at
            item.view_count = metadata.get("view_count")
            item.like_count = metadata.get("like_count")

    if not transcript or not transcript.get("segments"):
        raise RuntimeError("no transcript available")

    emit({"stage": "summarize", "status": "start"})
    structured = summarize(item, transcript, stages, target_lang=target_lang, on_progress=emit)
    # Bilibili audience mood from 弹幕 — a separate LLM call, merged into the
    # structured summary so it renders + persists alongside the spoken summary.
    if danmaku:
        emit({"stage": "summarize", "detail": "danmaku mood"})
        dm = summarize_danmaku(danmaku, stages)
        if dm:
            structured["danmaku"] = dm
    markdown = render_markdown(item, structured)
    chunks = _chunk_for_embed(transcript, structured, markdown)

    return {
        "metadata": metadata,
        "transcript": transcript,
        "summary": {
            "model": os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"),
            "prompt_version": PROMPT_VERSION,
            "markdown": markdown,
            "structured": structured,
        },
        "chunks": chunks,
        "media": media,
        "stages": [_stage_dict(s) for s in stages],
        "error": None,
    }


def _transcribe(tmp: str, audio_path: Path, stages: list[Stage], on_progress=None) -> dict:
    import httpx

    with Stage("transcribe", provider="openrouter", model=os.environ.get("STT_MODEL")) as st:
        workdir = Path(tmp) / "chunks"
        chunk_paths = split_audio(str(audio_path), TRANSCRIBE_CHUNK_SECONDS, workdir)
        if not chunk_paths:
            raise RuntimeError("no audio chunks produced")
        chunk_count = len(chunk_paths)
        usage = llm.SttUsage()
        segments: list[dict] = []
        offset = 0.0
        language = None
        with httpx.Client(timeout=300) as client:
            for index, chunk in enumerate(chunk_paths, start=1):
                dur = probe_duration(chunk)
                text, detected = llm.transcribe_chunk(client, str(chunk), usage)
                language = language or detected
                if text:
                    segments.append({"start": round(offset, 2), "end": round(offset + dur, 2),
                                     "text": to_simplified(text.strip())})
                offset += dur
                if on_progress:
                    try:
                        on_progress({"stage": "transcribe", "chunk_done": index,
                                     "chunk_count": chunk_count,
                                     "pct": round(index / chunk_count * 100, 1)})
                    except Exception:  # noqa: BLE001
                        pass
        st.request_count = usage.requests
        st.total_tokens = usage.total_tokens
        st.cost_usd = usage.cost_usd
    stages.append(st)
    return {"language": language, "source": "openrouter_whisper", "segments": segments,
            "text": "\n".join(s["text"] for s in segments)}


def _stage_dict(s: Stage) -> dict:
    return {"stage": s.stage, "provider": s.provider, "model": s.model, "duration_ms": s.duration_ms,
            "request_count": s.request_count, "total_tokens": s.total_tokens, "cost_usd": s.cost_usd,
            "error": s.error}
