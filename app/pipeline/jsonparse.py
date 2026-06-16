"""Robust extraction of a JSON object from an LLM response.

Models asked for "STRICT JSON" sometimes still wrap the object in prose
("Here is the JSON:"), markdown fences, or truncate it mid-stream. The reduce
step depends on this JSON for everything except the walkthrough, so a single
stray token used to collapse a whole summary down to its walkthrough-only
fallback. This recovers the first balanced top-level object, tolerating those
cases.
"""

from __future__ import annotations

import json
import re

_FENCE_OPEN = re.compile(r"^```[a-zA-Z0-9]*\s*")


def extract_json(text: str | None) -> dict:
    """Return the first balanced JSON object in `text`.

    Raises json.JSONDecodeError when nothing parseable can be recovered.
    """
    if not text or not text.strip():
        raise json.JSONDecodeError("empty response", text or "", 0)
    t = text.strip()

    # Strip a wrapping ```json ... ``` fence if present.
    if t.startswith("```"):
        t = _FENCE_OPEN.sub("", t)
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
        t = t.strip()

    # Fast path: the whole response is a JSON object.
    try:
        obj = json.loads(t)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    # Scan for the first balanced {...}, ignoring braces inside strings, so a
    # prose preamble/epilogue around the object is tolerated.
    start = t.find("{")
    if start == -1:
        raise json.JSONDecodeError("no JSON object found", t, 0)
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(t)):
        ch = t[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(t[start : i + 1])

    # Unterminated (truncated mid-object): best-effort salvage by closing the
    # dangling string and braces so the partial content still parses.
    candidate = t[start:]
    if in_str:
        candidate += '"'
    candidate += "}" * depth
    return json.loads(candidate)
