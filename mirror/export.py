"""Export the stream-reduce content as a static JSON bundle for the mirror SPA.

Reads from a running REST API (the NAS app, typically reached over an SSH
tunnel) and writes, under ``<out_dir>/data``:

- ``items.json``        -> all done, non-archived items (slimmed: no cost/token
                           metrics, no media paths).
- ``groups.json``       -> folders with their non-archived item counts.
- ``items/<id>.json``   -> per-item detail (summary + transcript + metadata),
                           with stages / comments / media internals dropped.
- ``search-index.json.gz`` -> gzipped flat passage docs (transcript windows +
                           summary fields) for the client-side keyword index.
                           Gzipped because the raw JSON outgrows Cloudflare
                           Pages' 25 MiB per-file limit; the SPA inflates it in
                           the browser before building the MiniSearch index.
- ``graph.json``        -> the unified paragraph knowledge graph (summary
                           paragraphs as nodes + similarity edges).
- ``meta.json``         -> ``{generated_at, item_count}``.

The mirror is read-only and keyword-searched in the browser, so no embeddings,
secrets, or live API are involved at serve time.
"""

from __future__ import annotations

import argparse
import gzip
import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

# Fetches a parsed-JSON response for an API path + optional query params. This
# indirection lets the bundle be built either over plain HTTP (a reachable API)
# or by running `curl` on the NAS over SSH (when TCP forwarding is disabled).
FetchJson = Callable[[str, dict[str, Any] | None], Any]
# Fetches a raw asset (e.g. a thumbnail) for a path, or None if it is missing.
FetchBytes = Callable[[str], bytes | None]

PAGE_SIZE = 500
# Transcript passages are windowed to roughly this many characters so keyword
# hits land on a readable, deep-linkable span rather than a whole transcript.
TRANSCRIPT_WINDOW_CHARS = 1200

# Item fields that expose processing cost / internal storage; zeroed or dropped
# so the public bundle carries content only (the "statistical part" stays private).
_ZERO_FIELDS = (
    "total_processing_ms",
    "total_api_requests",
    "total_tokens",
    "total_cost_usd",
    "retry_count",
)


def http_fetchers(base_url: str) -> tuple[FetchJson, FetchBytes]:
    """JSON + bytes fetchers backed by httpx against a reachable API base URL."""
    client = httpx.Client(base_url=base_url.rstrip("/"), timeout=60)

    def fetch(path: str, params: dict[str, Any] | None = None) -> Any:
        return client.get(path, params=params or {}).raise_for_status().json()

    def fetch_bytes(path: str) -> bytes | None:
        resp = client.get(path)
        return resp.content if resp.status_code == 200 else None

    return fetch, fetch_bytes


def _slim_item(item: dict[str, Any]) -> dict[str, Any]:
    """Strip cost/token metrics and internal media paths from a list item."""
    slim = dict(item)
    for field in _ZERO_FIELDS:
        if field in slim:
            slim[field] = 0
    slim["media_path"] = None
    slim["media_bytes"] = 0
    slim["audio_duration_s"] = None
    slim["started_at"] = None
    slim["completed_at"] = None
    return slim


def _text_of(element: Any) -> str:
    """Best-effort plain text for a structured-summary list element."""
    if isinstance(element, str):
        return element
    if isinstance(element, dict):
        return " ".join(str(v) for v in element.values() if isinstance(v, (str, int, float)))
    return str(element)


def deep_link(source_url: str, platform: str, seconds: float | None) -> str | None:
    """A URL that jumps to ``seconds`` in the source media, when supported.

    Mirrors ``app.search.deep_link`` so mirror hits link back like the live app.
    """
    if not source_url:
        return None
    if seconds is not None and platform in ("youtube", "bilibili"):
        sep = "&" if "?" in source_url else "?"
        return f"{source_url}{sep}t={int(seconds)}s"
    return source_url


def _transcript_docs(detail: dict[str, Any], next_id: list[int]) -> list[dict[str, Any]]:
    transcript = detail.get("transcript")
    if not transcript:
        return []
    segments = transcript.get("segments") or []
    docs: list[dict[str, Any]] = []
    buf: list[str] = []
    buf_len = 0
    win_start: float | None = None
    win_end: float | None = None

    def flush() -> None:
        nonlocal buf, buf_len, win_start, win_end
        text = " ".join(buf).strip()
        if text:
            docs.append(
                _doc(
                    detail,
                    next_id,
                    source="transcript",
                    field="transcript",
                    text=text,
                    start_s=win_start,
                    end_s=win_end,
                )
            )
        buf, buf_len, win_start, win_end = [], 0, None, None

    for seg in segments:
        seg_text = (seg.get("text") or "").strip()
        if not seg_text:
            continue
        if win_start is None:
            win_start = seg.get("start")
        win_end = seg.get("end")
        buf.append(seg_text)
        buf_len += len(seg_text)
        if buf_len >= TRANSCRIPT_WINDOW_CHARS:
            flush()
    flush()
    return docs


def _summary_docs(detail: dict[str, Any], next_id: list[int]) -> list[dict[str, Any]]:
    summary = detail.get("summary")
    if not summary:
        return []
    docs: list[dict[str, Any]] = []
    structured = summary.get("structured") or {}

    tldr = structured.get("tldr")
    if isinstance(tldr, str) and tldr.strip():
        docs.append(_doc(detail, next_id, source="summary", field="tldr", text=tldr.strip()))

    for field in ("key_points", "quotes", "outline", "entities"):
        value = structured.get(field)
        if isinstance(value, list):
            for element in value:
                text = _text_of(element).strip()
                if text:
                    docs.append(_doc(detail, next_id, source="summary", field=field, text=text))

    markdown = summary.get("markdown")
    if isinstance(markdown, str) and markdown.strip():
        docs.append(
            _doc(detail, next_id, source="summary", field="markdown", text=markdown.strip())
        )
    return docs


def _doc(
    detail: dict[str, Any],
    next_id: list[int],
    *,
    source: str,
    field: str,
    text: str,
    start_s: float | None = None,
    end_s: float | None = None,
) -> dict[str, Any]:
    cid = next_id[0]
    next_id[0] += 1
    platform = detail.get("platform", "unknown")
    source_url = detail.get("source_url", "")
    return {
        "id": cid,
        "chunk_id": cid,
        "item_id": detail["id"],
        "title": detail.get("title"),
        "source_url": source_url,
        "platform": platform,
        "author": detail.get("author"),
        "source": source,
        "field": field,
        "text": text,
        "start_s": start_s,
        "end_s": end_s,
        "deep_link": deep_link(source_url, platform, start_s),
    }


def _slim_detail(detail: dict[str, Any]) -> dict[str, Any]:
    """Per-item detail with processing internals removed; summary+transcript kept."""
    slim = _slim_item(detail)
    slim["stages"] = []
    slim["comments"] = []
    slim["highlights"] = []
    return slim


def _fetch_graph(fetch: FetchJson) -> dict[str, Any]:
    """The unified paragraph graph (nodes already carry their text, so this is a
    single fetch; the mirror serves it as-is)."""
    return fetch("/api/graph", None) or {}


def _export_thumbnails(
    items: list[dict[str, Any]], fetch_bytes: FetchBytes, out_dir: Path
) -> int:
    """Download locally-hosted thumbnails so the mirror's ``/media/...`` <img>
    paths resolve. External (http) thumbnails are left as-is."""
    downloaded = 0
    for item in items:
        thumb = item.get("thumbnail")
        if not thumb or not thumb.startswith("/media/"):
            continue
        data = fetch_bytes(thumb)
        if data is None:
            print(f"  warn: thumbnail missing for item {item['id']}: {thumb}")
            continue
        dest = out_dir / thumb.lstrip("/")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        downloaded += 1
    return downloaded


def export(fetch: FetchJson, fetch_bytes: FetchBytes, out_dir: Path) -> dict[str, Any]:
    data_dir = out_dir / "data"
    items_dir = data_dir / "items"
    items_dir.mkdir(parents=True, exist_ok=True)

    items = _fetch_items(fetch)
    groups = fetch("/api/items/groups", {"archived": "false"})

    search_docs: list[dict[str, Any]] = []
    next_id = [0]
    slim_items: list[dict[str, Any]] = []
    for item in items:
        detail = fetch(f"/api/items/{item['id']}", None)
        slim_items.append(_slim_item(item))
        slim_detail = _slim_detail(detail)
        # Embed related-article recommendations so the mirror's bottom-of-page
        # grid works without a live API.
        slim_detail["related"] = fetch(f"/api/items/{item['id']}/related", None) or []
        (items_dir / f"{item['id']}.json").write_text(
            json.dumps(slim_detail, ensure_ascii=False)
        )
        search_docs.extend(_transcript_docs(detail, next_id))
        search_docs.extend(_summary_docs(detail, next_id))

    thumbnails = _export_thumbnails(items, fetch_bytes, out_dir)
    graph = _fetch_graph(fetch)

    (data_dir / "items.json").write_text(json.dumps(slim_items, ensure_ascii=False))
    (data_dir / "groups.json").write_text(json.dumps(groups, ensure_ascii=False))
    # Gzipped: the raw index (tens of MiB once the library is large) exceeds
    # Cloudflare Pages' 25 MiB per-file limit. mtime=0 keeps the bytes stable
    # across runs when the content is unchanged.
    (data_dir / "search-index.json.gz").write_bytes(
        gzip.compress(
            json.dumps(search_docs, ensure_ascii=False).encode("utf-8"),
            compresslevel=9,
            mtime=0,
        )
    )
    (data_dir / "graph.json").write_text(json.dumps(graph, ensure_ascii=False))
    meta = {
        "generated_at": datetime.now(UTC).isoformat(),
        "item_count": len(slim_items),
        "search_docs": len(search_docs),
        "thumbnails": thumbnails,
        "graph_nodes": len(graph.get("nodes", [])),
    }
    (data_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return meta


def _fetch_items(fetch: FetchJson) -> list[dict[str, Any]]:
    """All done, non-archived items, following pagination."""
    items: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = fetch(
            "/api/items",
            {
                "status": "done",
                "archived": "false",
                "sort": "added",
                "order": "desc",
                "limit": PAGE_SIZE,
                "offset": offset,
            },
        )
        items.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return items


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the stream-reduce static mirror bundle.")
    parser.add_argument(
        "--base-url",
        default="http://localhost:8010",
        help="stream-reduce API base URL (default: %(default)s, e.g. via an SSH tunnel).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent / "dist",
        help="Output directory; data is written under <out>/data (default: %(default)s).",
    )
    args = parser.parse_args()
    fetch, fetch_bytes = http_fetchers(args.base_url)
    meta = export(fetch, fetch_bytes, args.out)
    print(
        f"Exported {meta['item_count']} items, {meta['search_docs']} search docs, "
        f"{meta['graph_nodes']} graph nodes, {meta['thumbnails']} thumbnails "
        f"-> {args.out / 'data'}"
    )


if __name__ == "__main__":
    main()
