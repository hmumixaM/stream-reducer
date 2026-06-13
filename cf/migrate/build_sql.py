"""Generate D1-import SQL from the NAS SQLite DB (stream_reduce.db).

Maps the single-user NAS schema onto the multi-user Cloudflare schema:
  * Global content  -> item / transcript / summary / chunk
  * Per-user state   -> user_item / itemgroup / comment / highlight, all owned
                        by a single OWNER account.

Audio/media is intentionally NOT migrated (media_key left NULL, media_bytes 0).
Embeddings are left NULL and regenerated on Cloudflare (bge-m3, 1024-dim) via the
worker's embed-backfill; the knowledge graph is rebuilt from those vectors.

Oversized text (transcript.segments/text, summary.markdown/structured) can exceed
D1's 100 KB per-statement limit, so those columns are written as a base row plus
chunked `col = col || '<slice>'` UPDATEs, each comfortably under the limit.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

SRC = Path(__file__).with_name("stream_reduce.db")
OUT = Path(__file__).with_name("out")
OWNER_EMAIL = "max@12450.top"
OWNER = f"(SELECT id FROM user WHERE email = '{OWNER_EMAIL}')"

# Max UTF-8 bytes per appended text slice. Statement overhead (~80 bytes) plus
# worst-case quote doubling keeps every statement well under D1's 100 KB cap.
SLICE_BYTES = 40_000
CHUNKS_PER_FILE = 3_000


def q(val: object) -> str:
    """Render a Python value as a SQLite literal."""
    if val is None:
        return "NULL"
    if isinstance(val, bool):
        return "1" if val else "0"
    if isinstance(val, (int, float)):
        return repr(val)
    return "'" + str(val).replace("'", "''") + "'"


def slices(text: str) -> list[str]:
    """Split a string into pieces whose UTF-8 length is <= SLICE_BYTES, never
    splitting a character."""
    out: list[str] = []
    buf: list[str] = []
    size = 0
    for ch in text:
        n = len(ch.encode("utf-8"))
        if size + n > SLICE_BYTES and buf:
            out.append("".join(buf))
            buf, size = [], 0
        buf.append(ch)
        size += n
    if buf:
        out.append("".join(buf))
    return out or [""]


def emit_text_row(
    table: str, base_cols: list[str], base_vals: list[object], big: dict[str, str], row_id: int
) -> list[str]:
    """INSERT a row with empty big-text columns, then append each big column in
    slices via UPDATE ... = col || '...'."""
    cols = base_cols + list(big.keys())
    vals = [q(v) for v in base_vals] + ["''"] * len(big)
    stmts = [f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(vals)});"]
    for col, text in big.items():
        for piece in slices(text or ""):
            if piece == "":
                continue
            stmts.append(
                f"UPDATE {table} SET {col} = {col} || {q(piece)} WHERE id = {row_id};"
            )
    return stmts


def thumb(platform: str, external_id: str | None, thumbnail: str | None) -> str | None:
    if thumbnail and thumbnail.startswith("http"):
        return thumbnail
    if platform == "youtube" and external_id:
        return f"https://i.ytimg.com/vi/{external_id}/hqdefault.jpg"
    return None  # local /media thumbnails don't exist on CF -> placeholder icon


def main() -> None:
    OUT.mkdir(exist_ok=True)
    c = sqlite3.connect(SRC)
    c.row_factory = sqlite3.Row

    # --- 00 reset (idempotent re-runs) -----------------------------------
    reset = [
        "DELETE FROM highlight;",
        "DELETE FROM comment;",
        "DELETE FROM user_item;",
        "DELETE FROM chunk;",
        "DELETE FROM summary;",
        "DELETE FROM transcript;",
        "DELETE FROM item;",
        "DELETE FROM itemgroup;",
        f"INSERT OR IGNORE INTO user (email) VALUES ('{OWNER_EMAIL}');",
    ]
    (OUT / "00_reset.sql").write_text("\n".join(reset) + "\n")

    # --- 01 itemgroup + item + user_item + comment + highlight ----------
    base: list[str] = []
    for g in c.execute("SELECT * FROM itemgroup ORDER BY id"):
        base.append(
            "INSERT INTO itemgroup (id, user_id, platform, external_id, source_url, title, item_count, created_at) "
            f"VALUES ({g['id']}, {OWNER}, {q(g['platform'])}, {q(g['external_id'])}, {q(g['source_url'])}, "
            f"{q(g['title'])}, {g['item_count']}, {q(g['created_at'])});"
        )

    item_cols = (
        "id, platform, source_url, external_id, title, author, description, duration_s, published_at, "
        "thumbnail, view_count, like_count, dislike_count, status, error, request_count, subscriber_demand, "
        "priority_score, media_key, media_bytes, audio_duration_s, enqueued_at, started_at, completed_at, "
        "total_processing_ms, total_api_requests, total_tokens, total_cost_usd, retry_count, created_at"
    )
    for it in c.execute("SELECT * FROM item ORDER BY id"):
        vals = [
            it["id"], q(it["platform"]), q(it["source_url"]), q(it["external_id"]), q(it["title"]),
            q(it["author"]), q(it["description"]), q(it["duration_s"]), q(it["published_at"]),
            q(thumb(it["platform"], it["external_id"], it["thumbnail"])), q(it["view_count"]),
            q(it["like_count"]), q(it["dislike_count"]), q(it["status"]), q(it["error"]),
            "0", "0", "0",          # request_count, subscriber_demand, priority_score
            "NULL", "0", q(it["audio_duration_s"]),  # media_key, media_bytes, audio_duration_s
            q(it["enqueued_at"]), q(it["started_at"]), q(it["completed_at"]),
            it["total_processing_ms"], it["total_api_requests"], it["total_tokens"],
            repr(it["total_cost_usd"]), it["retry_count"], q(it["created_at"]),
        ]
        base.append(f"INSERT INTO item ({item_cols}) VALUES ({', '.join(str(v) for v in vals)});")

        personal = "done" if it["status"] == "done" else "waiting"
        base.append(
            "INSERT INTO user_item (user_id, item_id, folder_id, group_position, is_favorite, is_archived, "
            "personal_status, subscription_id, added_at) VALUES ("
            f"{OWNER}, {it['id']}, {q(it['group_id'])}, {q(it['group_position'])}, {it['is_favorite']}, "
            f"{it['is_archived']}, {q(personal)}, NULL, {q(it['created_at'])});"
        )

    for cm in c.execute("SELECT * FROM comment ORDER BY id"):
        base.append(
            "INSERT INTO comment (id, item_id, user_id, body, created_at) VALUES ("
            f"{cm['id']}, {cm['item_id']}, {OWNER}, {q(cm['body'])}, {q(cm['created_at'])});"
        )
    for h in c.execute("SELECT * FROM highlight ORDER BY id"):
        base.append(
            "INSERT INTO highlight (id, item_id, user_id, source, quote, note, color, prefix, suffix, created_at) "
            f"VALUES ({h['id']}, {h['item_id']}, {OWNER}, {q(h['source'])}, {q(h['quote'])}, {q(h['note'])}, "
            f"{q(h['color'])}, {q(h['prefix'])}, {q(h['suffix'])}, {q(h['created_at'])});"
        )
    (OUT / "01_items.sql").write_text("\n".join(base) + "\n")

    # --- 02 transcripts (chunked-append for big columns) -----------------
    tr: list[str] = []
    for t in c.execute("SELECT * FROM transcript ORDER BY id"):
        tr += emit_text_row(
            "transcript",
            ["id", "item_id", "language", "source", "created_at"],
            [t["id"], t["item_id"], q(t["language"]), q(t["source"]), q(t["created_at"])],
            {"segments": t["segments"] or "[]", "text": t["text"] or ""},
            t["id"],
        )
    (OUT / "02_transcripts.sql").write_text("\n".join(tr) + "\n")

    # --- 03 summaries (chunked-append for big columns) -------------------
    sm: list[str] = []
    for s in c.execute("SELECT * FROM summary ORDER BY id"):
        sm += emit_text_row(
            "summary",
            ["id", "item_id", "model", "prompt_version", "created_at"],
            [s["id"], s["item_id"], q(s["model"]), q(s["prompt_version"]), q(s["created_at"])],
            {"markdown": s["markdown"] or "", "structured": s["structured"] or "{}"},
            s["id"],
        )
    (OUT / "03_summaries.sql").write_text("\n".join(sm) + "\n")

    # --- 04+ chunks (text <= 6 KB, plain inserts, split across files) ----
    chunk_cols = (
        "id, item_id, source, field, chunk_index, text, start_s, end_s, char_start, char_end, "
        "token_count, content_hash, embedding_model, embedding, created_at"
    )
    rows = c.execute("SELECT * FROM chunk ORDER BY id").fetchall()
    files = 0
    for i in range(0, len(rows), CHUNKS_PER_FILE):
        part = rows[i : i + CHUNKS_PER_FILE]
        lines = []
        for ch in part:
            lines.append(
                f"INSERT INTO chunk ({chunk_cols}) VALUES ("
                f"{ch['id']}, {ch['item_id']}, {q(ch['source'])}, {q(ch['field'])}, {ch['chunk_index']}, "
                f"{q(ch['text'])}, {q(ch['start_s'])}, {q(ch['end_s'])}, {q(ch['char_start'])}, "
                f"{q(ch['char_end'])}, {ch['token_count']}, {q(ch['content_hash'])}, '', NULL, {q(ch['created_at'])});"
            )
        (OUT / f"04_chunks_{files:03d}.sql").write_text("\n".join(lines) + "\n")
        files += 1

    # Verify no generated statement exceeds D1's 100 KB cap.
    worst = 0
    for f in OUT.glob("*.sql"):
        for line in f.read_text().splitlines():
            worst = max(worst, len(line.encode("utf-8")))
    print(f"itemgroups + items + user_item + comments + highlights -> 01_items.sql")
    print(f"transcripts -> 02 ({len(tr)} stmts), summaries -> 03 ({len(sm)} stmts)")
    print(f"chunks -> {files} files ({len(rows)} rows)")
    print(f"largest single statement: {worst} bytes (limit 100000)")


if __name__ == "__main__":
    main()
