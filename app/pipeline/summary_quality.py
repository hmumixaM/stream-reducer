"""Quality checks that prevent incomplete map notes from becoming summaries."""

from __future__ import annotations

import re

_TIMESTAMP_RE = re.compile(r"\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]")
_HEADING_TIMESTAMP_RE = re.compile(
    r"^\s*#{2,4}\s+\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]",
    re.MULTILINE,
)


def _seconds(match: re.Match[str]) -> int:
    return (
        int(match.group(1) or 0) * 3600
        + int(match.group(2)) * 60
        + int(match.group(3))
    )


def map_notes_issue(notes: str, source_chunk: str) -> str | None:
    """Return why map notes look incomplete, or ``None`` when they pass.

    Map prompts require timestamped headings every few minutes. Comparing their
    latest heading with the source chunk's timestamp range detects responses
    that stop partway through despite returning HTTP 200 and non-empty text.
    """

    minimum_chars = max(400, min(1500, int(len(source_chunk) * 0.12)))
    if len(notes.strip()) < minimum_chars:
        return f"only {len(notes.strip())} chars; expected at least {minimum_chars}"

    source_times = [_seconds(match) for match in _TIMESTAMP_RE.finditer(source_chunk)]
    heading_times = [
        _seconds(match) for match in _HEADING_TIMESTAMP_RE.finditer(notes)
    ]
    if not source_times:
        return None
    if not heading_times:
        return "no timestamped section headings"

    start, end = min(source_times), max(source_times)
    span = end - start
    if span <= 180:
        return None

    latest_required = end - min(180, int(span * 0.35))
    latest_heading = max(heading_times)
    if latest_heading < latest_required:
        return (
            f"latest heading is {latest_heading}s but source reaches {end}s "
            f"(expected at least {latest_required}s)"
        )
    return None
