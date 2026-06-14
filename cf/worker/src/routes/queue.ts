import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, type ItemRow, type UserItemRow } from "../db";
import { toItemRead } from "../lib/serialize";

export const queueRoutes = new Hono<AppContext>();
queueRoutes.use("*", requireAuth);

// The user's in-flight library: anything not yet done, plus recent errors,
// ordered by processing priority (highest-demand first).
queueRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  // Total items still ahead in the global pipeline (for an ETA hint).
  const totalRow = await all<{ n: number }>(
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM item WHERE status != 'done'"),
  );
  const queueTotal = totalRow[0]?.n ?? 0;

  const rows = await all<ItemRow & { ui_folder: number | null; ui_fav: number; ui_arch: number; ui_status: string; current_stage: string | null; chunk_done: number; chunk_count: number; queue_position: number }>(
    c.env.DB.prepare(
      `SELECT item.*, ui.folder_id AS ui_folder, ui.is_favorite AS ui_fav,
              ui.is_archived AS ui_arch, ui.personal_status AS ui_status,
              (SELECT stage FROM stage_run WHERE item_id = item.id ORDER BY id DESC LIMIT 1) AS current_stage,
              (SELECT chunk_done FROM stage_run WHERE item_id = item.id ORDER BY id DESC LIMIT 1) AS chunk_done,
              (SELECT chunk_count FROM stage_run WHERE item_id = item.id ORDER BY id DESC LIMIT 1) AS chunk_count,
              -- Rank in the global processing order (same ordering the worker
              -- claims by): how many non-done items are scheduled ahead of this.
              (SELECT COUNT(*) FROM item o WHERE o.status != 'done'
                 AND (o.priority_score > item.priority_score
                   OR (o.priority_score = item.priority_score AND o.request_count > item.request_count)
                   OR (o.priority_score = item.priority_score AND o.request_count = item.request_count AND o.enqueued_at < item.enqueued_at))) + 1 AS queue_position
         FROM user_item ui JOIN item ON item.id = ui.item_id
        WHERE ui.user_id = ? AND item.status != 'done'
        ORDER BY item.priority_score DESC, item.enqueued_at DESC`,
    ).bind(userId),
  );
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
      queue_position: r.queue_position,
      queue_total: queueTotal,
    })),
  );
});
