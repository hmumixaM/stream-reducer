"""Deterministic checks around the two LLM quote passes (pick, then review).

Quotes are picked from walkthrough notes that mix the note-taker's narration
with the speakers' own words. Only words the notes put inside quotation marks
may be printed as a quote, so every candidate is matched back to a quoted span.
"""

from __future__ import annotations

import re
import unicodedata

MAX_QUOTES = 8
# CJK characters count 1, other words count 2: "Move fast and break things"
# and "规模大了故障就是常态" both clear it, "草包" and "Amazing" do not.
MIN_QUOTE_WEIGHT = 10
# About 100 Chinese characters or 50 English words: past that it is a passage,
# not a pull quote. Applied after review, since the reviewer may trim.
MAX_QUOTE_WEIGHT = 100

_QUOTED_SPAN_RE = re.compile(r"“([^”]+)”|「([^」]+)」|『([^』]+)』|\"([^\"\n]+)\"")
_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")
_WORD_RE = re.compile(r"[^\W_]+")
_WRAPPING_QUOTES = "“”「」『』\"'‘’ "


def _normalize(text: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKC", text).casefold() if ch.isalnum())


def quote_weight(text: str) -> int:
    return len(_CJK_RE.findall(text)) + 2 * len(_WORD_RE.findall(_CJK_RE.sub(" ", text)))


def quoted_spans(source: str) -> list[str]:
    return [_normalize(next(g for g in m.groups() if g)) for m in _QUOTED_SPAN_RE.finditer(source)]


def verified_quotes(candidates: list, source: str) -> list[dict]:
    """Keep candidates that sit inside a quoted span of ``source``, are long
    enough to carry a claim, and do not repeat an earlier candidate."""
    spans = quoted_spans(source)
    seen: list[str] = []
    out: list[dict] = []
    for cand in candidates:
        if not isinstance(cand, dict):
            continue
        text = str(cand.get("text") or "").strip(_WRAPPING_QUOTES)
        norm = _normalize(text)
        if quote_weight(text) < MIN_QUOTE_WEIGHT or not any(norm in span for span in spans):
            continue
        if any(norm in prev or prev in norm for prev in seen):
            continue
        seen.append(norm)
        out.append({**cand, "text": text})
    return out


def printable(quote: dict) -> bool:
    return quote_weight(quote["text"]) <= MAX_QUOTE_WEIGHT


def public_quote(quote: dict) -> dict:
    return {
        "text": quote["text"],
        "timestamp": quote.get("timestamp"),
        "speaker": quote.get("speaker"),
    }


def format_candidates(candidates: list[dict]) -> str:
    lines: list[str] = []
    for i, cand in enumerate(candidates, start=1):
        speaker = f" — {cand['speaker']}" if cand.get("speaker") else ""
        lines.append(f"[{i}] “{cand['text']}”{speaker}")
        if cand.get("claim"):
            lines.append(f"    Speaker's point: {cand['claim']}")
    return "\n".join(lines)


def apply_review(candidates: list[dict], picks: list, limit: int = MAX_QUOTES) -> list[dict]:
    """Return the reviewer's printable picks in its order. A pick may trim its
    candidate to a shorter excerpt; any other edit falls back to the candidate."""
    out: list[dict] = []
    used: set[int] = set()
    for pick in picks:
        if not isinstance(pick, dict):
            continue
        number = pick.get("id")
        if not isinstance(number, int) or not 1 <= number <= len(candidates) or number in used:
            continue
        used.add(number)
        cand = candidates[number - 1]
        text = str(pick.get("text") or "").strip(_WRAPPING_QUOTES)
        is_excerpt = _normalize(text) in _normalize(cand["text"])
        if not (text and quote_weight(text) >= MIN_QUOTE_WEIGHT and is_excerpt):
            text = cand["text"]
        quote = public_quote({**cand, "text": text})
        if not printable(quote):
            continue
        out.append(quote)
        if len(out) == limit:
            break
    return out
