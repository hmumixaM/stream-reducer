import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, type ItemRow, type UserItemRow } from "../db";
import { toItemRead } from "../lib/serialize";

export const queueRoutes = new Hono<AppContext>();
queueRoutes.use("*", requireAuth);

// Mirror of the consumer's STALE_IN_PROGRESS_MS: an item still in-progress past
// this long was orphaned by a Worker eviction and is waiting to be reclaimed,
// so the UI shows it as "stalled" rather than pretending it's actively running.
const STALE_IN_PROGRESS_MS = 20 * 60 * 1000;
const IN_PROGRESS = new Set(["fetching", "transcribing", "summarizing"]);

// The navigation badge polls on every signed-in page. It only needs a count,
// rather than thousands of serialized items and their global ranks.
queueRoutes.get("/count", async (c) => {
  const rows = await all<{ n: number }>(c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_item ui JOIN item i ON i.id=ui.item_id
     WHERE ui.user_id=? AND i.status NOT IN ('done', 'excluded', 'error')`,
  ).bind(c.get("user").id));
  return c.json({ active: rows[0]?.n ?? 0 });
});

// The user's in-flight library: anything not yet done, plus recent errors,
// ordered by processing priority (highest-demand first).
queueRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  // Total items still ahead in the global pipeline (for an ETA hint).
  const totalRow = await all<{ n: number }>(
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM item WHERE status NOT IN ('done', 'excluded')"),
  );
  const queueTotal = totalRow[0]?.n ?? 0;

  const rows = await all<ItemRow & { ui_folder: number | null; ui_fav: number; ui_arch: number; ui_status: string; current_stage: string | null; chunk_done: number; chunk_count: number; queue_position: number; progress_stage: string | null; progress_pct: number | null; progress_detail: string | null }>(
    c.env.DB.prepare(
      `WITH ranked AS (
         SELECT id, RANK() OVER (
           ORDER BY priority_score DESC, request_count DESC, enqueued_at ASC
         ) AS queue_position
         FROM item WHERE status NOT IN ('done', 'excluded')
       )
       SELECT item.*, ui.folder_id AS ui_folder, ui.is_favorite AS ui_fav,
              ui.is_archived AS ui_arch, ui.personal_status AS ui_status,
              (SELECT stage FROM stage_run WHERE item_id = item.id ORDER BY id DESC LIMIT 1) AS current_stage,
              (SELECT chunk_done FROM stage_run WHERE item_id = item.id ORDER BY id DESC LIMIT 1) AS chunk_done,
              (SELECT chunk_count FROM stage_run WHERE item_id = item.id ORDER BY id DESC LIMIT 1) AS chunk_count,
              ranked.queue_position
         FROM user_item ui JOIN item ON item.id = ui.item_id
         JOIN ranked ON ranked.id=item.id
        WHERE ui.user_id = ? AND item.status NOT IN ('done', 'excluded')
        ORDER BY item.priority_score DESC, item.enqueued_at DESC`,
    ).bind(userId),
  );
  const staleBefore = Date.now() - STALE_IN_PROGRESS_MS;
  return c.json(
    rows.map((r) => ({
      ...toItemRead(r, {
        folder_id: r.ui_folder,
        is_favorite: r.ui_fav,
        is_archived: r.ui_arch,
        personal_status: r.ui_status,
        subscription_id: null,
        group_position: null,
      } as UserItemRow),
      current_stage: r.current_stage,
      chunk_done: r.chunk_done ?? 0,
      chunk_count: r.chunk_count ?? 0,
      // Live progress heartbeated by the consumer while the job streams.
      progress_stage: r.progress_stage ?? null,
      progress_pct: r.progress_pct ?? null,
      progress_detail: r.progress_detail ?? null,
      queue_position: r.queue_position,
      queue_total: queueTotal,
      // True when the row claims to be running but its container was orphaned
      // (no heartbeat past the reclaim cutoff) — i.e. stuck, not progressing.
      stalled:
        IN_PROGRESS.has(r.status) &&
        !!r.started_at &&
        new Date(r.started_at).getTime() < staleBefore,
    })),
  );
});
