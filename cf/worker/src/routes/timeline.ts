import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, type ItemRow } from "../db";
import { CHANNEL_SORT_COLUMNS, sortColumn, sortOrder } from "../lib/sort";
import { toItemRead } from "../lib/serialize";

export const timelineRoutes = new Hono<AppContext>();
timelineRoutes.use("*", requireAuth);

interface TimelineRow extends ItemRow {
  channel_id: number;
  channel_title: string | null;
  discovered_at: string | null;
  ui_id: number | null;
  folder_id: number | null;
  group_position: number | null;
  is_favorite: number | null;
  is_archived: number | null;
  personal_status: string | null;
  subscription_id: number | null;
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

// Everything the user's followed channels have surfaced, newest first. An item
// linked to two followed channels must appear once, hence the GROUP BY.
timelineRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  const query = c.req.query();
  const where = ["s.user_id = ?", "i.status != 'excluded'"];
  // Bind order follows the SQL text: the LEFT JOIN's user id comes first,
  // then the WHERE clause's, then any filter values appended below.
  const binds: unknown[] = [userId, userId];
  if (query.platform) {
    where.push("i.platform = ?");
    binds.push(query.platform);
  }
  // Narrow the timeline to one followed channel (the avatar strip on the page).
  if (query.channel_id) {
    const channelId = Number(query.channel_id);
    if (!Number.isInteger(channelId) || channelId <= 0) {
      return c.json({ error: "channel_id must be a positive integer" }, 400);
    }
    where.push("ci.channel_id = ?");
    binds.push(channelId);
  }
  if (query.saved === "false") where.push("ui.id IS NULL");
  if (query.saved === "true") where.push("ui.id IS NOT NULL");
  if (query.ready === "true") where.push("i.status = 'done'");
  const sortCol = sortColumn(CHANNEL_SORT_COLUMNS, query.sort, "published");
  const order = sortOrder(query.order);
  const limit = boundedInt(query.limit, 30, 1, 100);
  const offset = boundedInt(query.offset, 0, 0, 1_000_000);

  const rows = await all<TimelineRow>(
    c.env.DB.prepare(
      `SELECT i.*,
              MIN(ci.channel_id) AS channel_id,
              MIN(ci.discovered_at) AS discovered_at,
              MIN(ch.title) AS channel_title,
              ui.id AS ui_id, ui.folder_id, ui.group_position, ui.is_favorite,
              ui.is_archived, ui.personal_status, ui.subscription_id
         FROM subscription s
         JOIN channel_item ci ON ci.channel_id = s.channel_id
         JOIN item i ON i.id = ci.item_id
         JOIN channel ch ON ch.id = ci.channel_id
         LEFT JOIN user_item ui ON ui.item_id = i.id AND ui.user_id = ?
        WHERE ${where.join(" AND ")}
        GROUP BY i.id
        ORDER BY ${sortCol} ${order}, i.id DESC
        LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset),
  );

  return c.json(
    rows.map((row) => ({
      ...toItemRead(
        row,
        row.ui_id == null
          ? null
          : {
              folder_id: row.folder_id,
              group_position: row.group_position,
              is_favorite: row.is_favorite ?? 0,
              is_archived: row.is_archived ?? 0,
              personal_status: row.personal_status ?? "waiting",
              subscription_id: row.subscription_id,
            },
      ),
      in_library: row.ui_id !== null,
      channel_id: row.channel_id,
      channel_title: row.channel_title,
      discovered_at: row.discovered_at,
    })),
  );
});
