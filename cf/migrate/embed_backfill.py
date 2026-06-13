"""Backfill Vectorize with bge-m3 (1024-dim) embeddings for migrated chunks.

The NAS used text-embedding-005 (768-dim), which is incompatible with the
Cloudflare Vectorize index (1024-dim bge-m3), so vectors are regenerated here
via the Workers AI REST API and upserted into Vectorize. This populates Search.

Search reads vectors from Vectorize (keyed by chunk id) and looks up chunk rows
from D1 by id, so embeddings are NOT written back to D1 (the graph, which would
need them, is intentionally skipped).

Auth: reuses CLOUDFLARE_API_TOKEN (the wrangler token). Idempotent: upsert
overwrites by id, so the script can be re-run safely.
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

ACCOUNT = "6789acff6cdae2c3d5073a701c708db7"
INDEX = "stream-reduce-chunks"
SRC = Path(__file__).with_name("stream_reduce.db")
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
EMBED_MODEL = "@cf/baai/bge-m3"

# bge-m3 caps each request at 60k tokens across the whole batch. Batch by a
# conservative character budget (~1 token/char for CJK) instead of a fixed count.
CHAR_BUDGET = 18_000  # CJK tokenizes to >1 token/char; stay well under 60k tokens
MAX_PER_CALL = 50     # also cap count per call
UPSERT_BATCH = 200    # vectors per Vectorize upsert call
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"


class ContextLimit(Exception):
    """bge-m3 batch exceeded the model's token budget; caller should split."""


def post(url: str, body: bytes, content_type: str) -> dict:
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", content_type)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body_text = e.read().decode(errors="replace")
            if e.code == 400 and "Max context" in body_text:
                raise ContextLimit(body_text) from None
            if attempt == 4:
                raise RuntimeError(f"HTTP {e.code}: {body_text[:300]}") from None
            time.sleep(2 * (attempt + 1))
            sys.stderr.write(f"retry {attempt + 1}: HTTP {e.code}\n")
        except Exception as e:  # noqa: BLE001 - retry transient network errors
            if attempt == 4:
                raise
            time.sleep(2 * (attempt + 1))
            sys.stderr.write(f"retry {attempt + 1}: {e}\n")
    return {}


def _batches(texts: list[str]):
    batch: list[str] = []
    size = 0
    for t in texts:
        n = max(1, len(t))
        if batch and (size + n > CHAR_BUDGET or len(batch) >= MAX_PER_CALL):
            yield batch
            batch, size = [], 0
        batch.append(t)
        size += n
    if batch:
        yield batch


def _embed_call(batch: list[str]) -> list[list[float]]:
    """Embed one batch; on a token-budget error, split and recurse."""
    try:
        d = post(
            f"{BASE}/ai/run/{EMBED_MODEL}",
            json.dumps({"text": batch}).encode(),
            "application/json",
        )
    except ContextLimit:
        if len(batch) == 1:
            # A single chunk over budget: truncate to a safe length and retry.
            return _embed_call([batch[0][:2000]])
        mid = len(batch) // 2
        return _embed_call(batch[:mid]) + _embed_call(batch[mid:])
    if not d.get("success"):
        raise RuntimeError(f"AI error: {d.get('errors')}")
    out = []
    for v in d["result"]["data"]:
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        out.append([x / norm for x in v])
    return out


def embed(texts: list[str]) -> list[list[float]]:
    out: list[list[float]] = []
    for batch in _batches(texts):
        out.extend(_embed_call(batch))
    return out


def upsert(records: list[dict]) -> None:
    for i in range(0, len(records), UPSERT_BATCH):
        batch = records[i : i + UPSERT_BATCH]
        ndjson = "\n".join(json.dumps(r) for r in batch).encode()
        d = post(
            f"{BASE}/vectorize/v2/indexes/{INDEX}/upsert",
            ndjson,
            "application/x-ndjson",
        )
        if not d.get("success"):
            raise RuntimeError(f"Vectorize upsert error: {d.get('errors')}")


def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    c = sqlite3.connect(SRC)
    c.row_factory = sqlite3.Row
    sql = (
        "SELECT id, item_id, source, field, text FROM chunk "
        "WHERE item_id IN (SELECT id FROM item) ORDER BY id"
    )
    rows = c.execute(sql).fetchall()
    if limit:
        rows = rows[:limit]
    total = len(rows)
    print(f"embedding {total} chunks", flush=True)

    GROUP = 500  # embed + upsert in groups to bound memory and show progress
    done = 0
    for i in range(0, total, GROUP):
        part = rows[i : i + GROUP]
        vectors = embed([r["text"] for r in part])
        records = [
            {
                "id": str(r["id"]),
                "values": vectors[j],
                "metadata": {"item_id": r["item_id"], "source": r["source"], "field": r["field"]},
            }
            for j, r in enumerate(part)
        ]
        upsert(records)
        done += len(part)
        print(f"  {done}/{total}", flush=True)
    print("done")


if __name__ == "__main__":
    main()
