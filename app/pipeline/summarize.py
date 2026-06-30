"""Map-reduce summarizer producing lossless, source-traceable summaries."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from sqlmodel import Session, select

from app.config import get_settings
from app.llm import generate_text
from app.models import Item, Platform, Summary, Transcript
from app.pipeline.jsonparse import extract_json
from app.pipeline.metrics import StageTracker
from app.pipeline.prompts import (
    MAP_SYSTEM,
    MAP_TEMPLATE,
    REDUCE_SYSTEM,
    REDUCE_TEMPLATE,
    STRICT_JSON_SUFFIX,
    language_directive,
)
from app.runtime_config import effective_llm_model, effective_summary_map_model

logger = logging.getLogger(__name__)


def fmt_timestamp(seconds: float | None) -> str:
    if seconds is None:
        return ""
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def timestamp_link(item: Item, seconds: float | None) -> str:
    label = fmt_timestamp(seconds)
    if seconds is None:
        return ""
    if item.platform in (Platform.youtube, Platform.bilibili) and item.source_url:
        sep = "&" if "?" in item.source_url else "?"
        return f"[{label}]({item.source_url}{sep}t={int(seconds)}s)"
    return f"`{label}`"


_TS_RE = re.compile(r"\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]")


def strip_body_timestamps(text: str) -> str:
    """Remove inline [HH:MM:SS] markers from prose, keeping only heading ones.

    The map model tends to tag nearly every sentence, which is noisy; readers only
    need an approximate, section-level timestamp (carried by the `###` headings).
    """
    out: list[str] = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            out.append(line)
            continue
        cleaned = _TS_RE.sub("", line)
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
        # Drop spaces left in front of CJK/ASCII punctuation after removal.
        cleaned = re.sub(r"\s+([，。、！？；：）),.!?;:])", r"\1", cleaned)
        out.append(cleaned.rstrip())
    return "\n".join(out)


def linkify_timestamps(item: Item, text: str) -> str:
    """Turn inline [HH:MM:SS]/[MM:SS] markers in prose into source-jump links."""

    def repl(m: re.Match) -> str:
        h = int(m.group(1) or 0)
        mins = int(m.group(2))
        secs = int(m.group(3))
        total = h * 3600 + mins * 60 + secs
        return timestamp_link(item, total)

    return _TS_RE.sub(repl, text)


PLATFORM_LABELS = {
    "youtube": "YouTube",
    "bilibili": "Bilibili",
    "apple_podcast": "Apple Podcasts",
    "xiaoyuzhou": "小宇宙",
    "rss": "RSS / web",
    "unknown": "web",
}


def _build_context(item: Item) -> str:
    """Assemble page background (uploader, platform, date, description) for the prompt."""
    lines = [
        f"- Title: {item.title or '(unknown)'}",
        f"- Platform: {PLATFORM_LABELS.get(item.platform.value, item.platform.value)}",
        f"- Submitted/published by: {item.author or '(unknown)'}",
    ]
    if item.published_at:
        lines.append(f"- Published: {item.published_at.date().isoformat()}")
    if item.duration_s:
        lines.append(f"- Duration: {fmt_timestamp(item.duration_s)}")
    lines.append(f"- Source URL: {item.source_url}")
    desc = (item.description or "").strip()
    if desc:
        # Keep the prompt bounded; descriptions can be very long.
        if len(desc) > 2000:
            desc = desc[:2000] + " …"
        lines.append(f"- Page description:\n{desc}")
    else:
        lines.append("- Page description: (none provided)")
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


def _record(tracker: StageTracker | None, result, model=None, status_code=200) -> None:
    if tracker is not None:
        tracker.record_call(
            provider="litellm",
            model=model or effective_llm_model(),
            endpoint="generateContent",
            latency_ms=result.latency_ms,
            status_code=status_code,
            prompt_tokens=result.prompt_tokens,
            completion_tokens=result.completion_tokens,
            tokens=result.total_tokens,
        )


def _strip_fences(text: str) -> str:
    """Remove a wrapping ```markdown ... ``` fence if the model added one."""
    text = text.strip()
    if text.startswith("```"):
        first_nl = text.find("\n")
        if first_nl != -1:
            text = text[first_nl + 1 :]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text


def _parse_json(text: str) -> dict:
    return extract_json(text)


_REDUCE_FALLBACK = {
    "background": "", "tldr": "", "atmosphere": "",
    "key_points": [], "quotes": [], "entities": [],
}


def _run_reduce(
    item: Item,
    walkthrough: str,
    lang_instruction: str,
    tracker: StageTracker | None,
) -> dict:
    """Reduce a walkthrough into the high-level framing JSON.

    Retries once with a stricter JSON-only instruction (long walkthroughs make
    the model more likely to wrap its JSON in prose) before falling back to a
    walkthrough-only summary.
    """
    settings = get_settings()
    reduce_prompt = REDUCE_TEMPLATE.format(
        context=_build_context(item),
        notes=walkthrough,
        language_instruction=lang_instruction,
    )
    for attempt in range(2):
        system = REDUCE_SYSTEM if attempt == 0 else REDUCE_SYSTEM + STRICT_JSON_SUFFIX
        result = generate_text(
            reduce_prompt, system=system, max_tokens=settings.summary_reduce_max_tokens
        )
        _record(tracker, result)
        try:
            return extract_json(result.text)
        except (json.JSONDecodeError, ValueError):
            logger.warning(
                "reduce JSON parse failed (attempt %d/2) for item %s", attempt + 1, item.id
            )
    logger.warning("reduce output unparseable for item %s; keeping walkthrough only", item.id)
    return dict(_REDUCE_FALLBACK)


def summarize_item(session: Session, item_id: int, tracker: StageTracker | None = None) -> Summary:
    settings = get_settings()
    item = session.get(Item, item_id)
    if item is None:
        raise ValueError(f"item {item_id} not found")
    transcript = session.exec(
        select(Transcript).where(Transcript.item_id == item_id)
    ).first()
    if transcript is None or not transcript.segments:
        raise ValueError(f"no transcript available for item {item_id}")

    chunks = _chunk_segments(transcript.segments, settings.summary_chunk_chars)

    # Decide the output language once from the actual transcript text so the
    # whole summary stays consistent (force Simplified Chinese for zh sources).
    lang_instruction = language_directive(transcript.text or "")

    # --- Map step: each chunk becomes a detailed chronological walkthrough. ---
    if tracker is not None:
        tracker.set_chunks(len(chunks))
    # Page title/description, used by the map step to fix obvious ASR errors.
    map_context = _build_context(item)
    note_blocks: list[str] = []
    for idx, chunk in enumerate(chunks, start=1):
        # Use the fast model for map; the reduce below uses the main model.
        map_model = effective_summary_map_model()
        result = generate_text(
            MAP_TEMPLATE.format(
                context=map_context, index=idx, total=len(chunks), chunk=chunk,
                language_instruction=lang_instruction,
            ),
            system=MAP_SYSTEM,
            model=map_model,
            max_tokens=settings.summary_map_max_tokens,
        )
        _record(tracker, result, model=map_model)
        note_blocks.append(strip_body_timestamps(_strip_fences(result.text).strip()))
        if tracker is not None:
            tracker.chunk_progress(idx)
    walkthrough = "\n\n".join(note_blocks)

    # --- Reduce step: high-level framing (background, TL;DR, atmosphere, etc.). ---
    structured = _run_reduce(item, walkthrough, lang_instruction, tracker)
    structured["walkthrough"] = walkthrough

    # --- Optional: separate danmaku (弹幕) mood summary, if any were captured. ---
    from app.pipeline.danmaku import load_danmaku, summarize_danmaku

    danmaku_items = load_danmaku(item_id)
    if danmaku_items:
        danmaku_summary = summarize_danmaku(danmaku_items, tracker)
        if danmaku_summary:
            structured["danmaku"] = danmaku_summary

    markdown = render_markdown(item, structured)
    summary = _store_summary(session, item_id, settings, markdown, structured)
    return summary


def is_walkthrough_only(structured: dict | None) -> bool:
    """True when a summary has its walkthrough but lost the reduce framing.

    These are the summaries produced when the reduce JSON failed to parse: only
    the detailed walkthrough survives, with no background/tl;dr/atmosphere/key
    points. Used to target the reduce-repair backfill.
    """
    s = structured or {}
    if not s.get("walkthrough"):
        return False
    return not any(s.get(k) for k in ("background", "tldr", "atmosphere", "key_points"))


def resummarize_reduce(
    session: Session, item_id: int, tracker: StageTracker | None = None
) -> Summary | None:
    """Re-run ONLY the reduce step from the already-stored walkthrough.

    A cheap repair for summaries that fell back to walkthrough-only because the
    reduce JSON failed to parse: no re-download, no transcription, and no map
    calls — just one (retried) reduce call. Returns None when the item has no
    stored walkthrough to reduce from.
    """
    settings = get_settings()
    item = session.get(Item, item_id)
    if item is None:
        raise ValueError(f"item {item_id} not found")
    summary = session.exec(select(Summary).where(Summary.item_id == item_id)).first()
    walkthrough = (summary.structured or {}).get("walkthrough") if summary else None
    if not walkthrough:
        return None

    transcript = session.exec(
        select(Transcript).where(Transcript.item_id == item_id)
    ).first()
    lang_source = (transcript.text if transcript else "") or walkthrough
    lang_instruction = language_directive(lang_source)

    structured = _run_reduce(item, walkthrough, lang_instruction, tracker)
    structured["walkthrough"] = walkthrough
    # Preserve a previously-computed danmaku mood block if present.
    prior_danmaku = (summary.structured or {}).get("danmaku")
    if prior_danmaku:
        structured["danmaku"] = prior_danmaku

    markdown = render_markdown(item, structured)
    return _store_summary(session, item_id, settings, markdown, structured)


def _store_summary(session, item_id, settings, markdown, structured) -> Summary:
    existing = session.exec(select(Summary).where(Summary.item_id == item_id)).first()
    if existing is not None:
        existing.model = effective_llm_model()
        existing.prompt_version = settings.summary_prompt_version
        existing.markdown = markdown
        existing.structured = structured
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return existing
    summary = Summary(
        item_id=item_id,
        model=effective_llm_model(),
        prompt_version=settings.summary_prompt_version,
        markdown=markdown,
        structured=structured,
    )
    session.add(summary)
    session.commit()
    session.refresh(summary)
    return summary


def summarize_via_gemini_audio(
    session: Session, item_id: int, audio_path: str, tracker: StageTracker | None = None
) -> Summary:
    """Last-resort path: send audio straight to Gemini for a structured summary.

    Used only when no transcript can be produced and the fallback is enabled.
    Sends the audio inline through the OpenAI-compatible multimodal API.
    """
    import base64

    from app.llm import generate_with_audio
    from app.pipeline.prompts import DIRECT_AUDIO_SYSTEM, REDUCE_TEMPLATE

    settings = get_settings()
    item = session.get(Item, item_id)
    if item is None:
        raise ValueError(f"item {item_id} not found")

    audio_b64 = base64.b64encode(Path(audio_path).read_bytes()).decode("ascii")
    fmt = Path(audio_path).suffix.lstrip(".") or "mp3"
    # No transcript here; infer language from the page title + description.
    prompt = REDUCE_TEMPLATE.format(
        context=_build_context(item),
        notes="(use the attached audio as the source)",
        language_instruction=language_directive(
            f"{item.title or ''}\n{item.description or ''}"
        ),
    )
    result = generate_with_audio(prompt, audio_b64, fmt, system=DIRECT_AUDIO_SYSTEM)
    _record(tracker, result)
    try:
        structured = _parse_json(result.text or "{}")
    except json.JSONDecodeError:
        structured = {"tldr": (result.text or "").strip(), "key_points": [],
                      "outline": [], "quotes": [], "entities": []}
    markdown = render_markdown(item, structured)
    return _store_summary(session, item_id, settings, markdown, structured)


def render_markdown(item: Item, structured: dict) -> str:
    lines: list[str] = []

    background = structured.get("background")
    if background:
        lines.append("## Background")
        lines.append(background)
        lines.append("")

    tldr = structured.get("tldr")
    if tldr:
        lines.append("## TL;DR")
        lines.append(tldr)
        lines.append("")

    atmosphere = structured.get("atmosphere")
    if atmosphere:
        lines.append("## Atmosphere & style")
        lines.append(atmosphere)
        lines.append("")

    danmaku = structured.get("danmaku")
    if danmaku:
        from app.pipeline.danmaku import render_danmaku_markdown

        lines.extend(render_danmaku_markdown(item, danmaku))

    key_points = structured.get("key_points") or []
    if key_points:
        lines.append("## Key takeaways")
        for kp in key_points:
            link = timestamp_link(item, kp.get("timestamp"))
            prefix = f"{link} " if link else ""
            lines.append(f"- {prefix}{kp.get('text', '')}")
        lines.append("")

    walkthrough = structured.get("walkthrough")
    if walkthrough:
        lines.append("## Detailed walkthrough")
        lines.append(linkify_timestamps(item, walkthrough).strip())
        lines.append("")

    quotes = structured.get("quotes") or []
    if quotes:
        lines.append("## Notable quotes")
        for q in quotes:
            link = timestamp_link(item, q.get("timestamp"))
            speaker = q.get("speaker")
            who = f" — {speaker}" if speaker else ""
            prefix = f"{link} " if link else ""
            # Blank line between quotes so each renders as its own blockquote.
            lines.append(f"> {prefix}{q.get('text', '')}{who}")
            lines.append("")

    entities = structured.get("entities") or []
    if entities:
        lines.append("## Mentioned")
        lines.append(", ".join(str(e) for e in entities))
        lines.append("")

    if item.source_url:
        lines.append(f"[Source]({item.source_url})")
    return "\n".join(lines).strip()
