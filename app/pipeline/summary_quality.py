"""Quality checks that prevent incomplete map notes from becoming summaries."""

from __future__ import annotations

import re

_TIMESTAMP_RE = re.compile(r"\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]")
_HEADING_TIMESTAMP_RE = re.compile(r"^\s*#{2,4}\s+\[", re.MULTILINE)


def map_notes_issue(notes: str, source_chunk: str) -> str | None:
    """Return why map notes look incomplete, or ``None`` when they pass.

    Detailed map output should retain a meaningful fraction of the source and
    include timestamped headings. Do not require a heading near the end: models
    often continue the final section for several minutes, so that check creates
    false failures even when the prose covers the conclusion.
    """

    minimum_chars = max(150, min(3000, int(len(source_chunk) * 0.15)))
    if len(notes.strip()) < minimum_chars:
        return f"only {len(notes.strip())} chars; expected at least {minimum_chars}"

    if _TIMESTAMP_RE.search(source_chunk) and not _HEADING_TIMESTAMP_RE.search(notes):
        return "no timestamped section headings"
    return None
