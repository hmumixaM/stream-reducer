"""Repair summaries that lost their reduce framing (walkthrough-only).

When the reduce step's JSON failed to parse, the summary fell back to just its
detailed walkthrough — no background, TL;DR, atmosphere, key takeaways, quotes,
or entities. This re-runs ONLY the reduce step from each item's already-stored
walkthrough (no re-download / transcription / map calls), then re-renders and
saves the summary. Idempotent and safe to re-run.

Usage:
    uv run python -m app.pipeline.reduce_backfill            # repair broken ones
    uv run python -m app.pipeline.reduce_backfill --all       # redo every summary
    uv run python -m app.pipeline.reduce_backfill --item 375  # one item
"""

from __future__ import annotations

import argparse
import logging

from sqlmodel import select

from app.db import init_db, session_scope
from app.models import StageName, Summary
from app.pipeline.metrics import StageTracker
from app.pipeline.summarize import is_walkthrough_only, resummarize_reduce

logger = logging.getLogger(__name__)


def _target_item_ids(session, force: bool) -> list[int]:
    summaries = session.exec(select(Summary)).all()
    ids: list[int] = []
    for s in summaries:
        if not (s.structured or {}).get("walkthrough"):
            continue  # nothing to reduce from
        if force or is_walkthrough_only(s.structured):
            ids.append(s.item_id)
    return sorted(ids)


def backfill(force: bool = False, item_id: int | None = None) -> dict:
    init_db()

    if item_id is not None:
        item_ids = [item_id]
    else:
        with session_scope() as session:
            item_ids = _target_item_ids(session, force)

    repaired = 0
    skipped = 0
    failed = 0
    for iid in item_ids:
        try:
            with session_scope() as session:
                with StageTracker(
                    session, iid, StageName.summarize, provider="litellm"
                ) as tracker:
                    result = resummarize_reduce(session, iid, tracker)
                if result is None:
                    skipped += 1
                    continue
                repaired += 1
                logger.info("repaired item %s (%d/%d)", iid, repaired, len(item_ids))
        except Exception:  # noqa: BLE001 - one bad item must not abort the run
            failed += 1
            logger.exception("reduce repair failed for item %s; continuing", iid)

    result = {
        "items_total": len(item_ids),
        "items_repaired": repaired,
        "items_skipped": skipped,
        "items_failed": failed,
    }
    logger.info("reduce backfill complete: %s", result)
    return result


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Repair walkthrough-only summaries via reduce-only.")
    parser.add_argument(
        "--all", dest="force", action="store_true",
        help="re-run reduce for every summary that has a walkthrough, not just broken ones",
    )
    parser.add_argument(
        "--item", dest="item_id", type=int, default=None,
        help="repair a single item id",
    )
    args = parser.parse_args()
    result = backfill(force=args.force, item_id=args.item_id)
    print(
        f"Repaired {result['items_repaired']} summary(ies); "
        f"skipped {result['items_skipped']} (no walkthrough); "
        f"failed {result['items_failed']}; "
        f"{result['items_total']} candidate(s) total."
    )


if __name__ == "__main__":
    main()
