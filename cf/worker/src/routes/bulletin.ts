import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";
import { generateReadingSummary, readCached, sourceHash, type ReadingRow } from "../lib/readingSummary";

import { serializeBulletin, type BulletinRow, bulletinMetadata as metadata, bulletinSortDate as sortDate, shortSummarySql } from "../lib/bulletinPresentation";
export { parseObject, parsePoints, serializeBulletin } from "../lib/bulletinPresentation";

export const bulletinRoutes = new Hono<AppContext>();
bulletinRoutes.use("*", requireAuth);

// EXISTS avoids duplicating large summary rows across the many-to-many channel joins.
const accessible = (includeCollections = false) => `FROM item i JOIN summary s ON s.item_id=i.id
  LEFT JOIN user_item ui ON ui.item_id=i.id AND ui.user_id=?
  LEFT JOIN bulletin_translation bt ON bt.item_id=i.id AND bt.lang='zh'
  WHERE i.status='done' AND (ui.id IS NOT NULL
    OR EXISTS (SELECT 1 FROM subscription sub JOIN channel_item ci ON ci.channel_id=sub.channel_id
      WHERE sub.user_id=? AND sub.enabled=1 AND ci.item_id=i.id)
    OR EXISTS (SELECT 1 FROM subscription sub JOIN item_feed f ON f.feed_url=sub.feed_url
      WHERE sub.user_id=? AND sub.enabled=1 AND f.item_id=i.id)
    ${includeCollections ? "OR EXISTS (SELECT 1 FROM collection_item ci JOIN collection c ON c.id=ci.collection_id WHERE ci.item_id=i.id AND c.is_public=1)" : ""})`;

bulletinRoutes.get("/feed", async (c) => {
  const params = c.req.query();
  const limit = Math.min(Math.max(Number(params.limit || 24), 1), 60);
  const offset = Math.min(Math.max(Number(params.offset || 0), 0), 10000);
  if (!Number.isInteger(limit) || !Number.isInteger(offset)) return c.json({ error: "Invalid pagination" }, 400);
  const user = c.get("user");
  const binds: unknown[] = [user.id, user.id, user.id];
  let filters = "";
  if (params.cursor) {
    let cursor: number[];
    try { cursor = JSON.parse(atob(params.cursor)); } catch { return c.json({ error: "Invalid cursor" }, 400); }
    if (!Array.isArray(cursor) || cursor.length !== 2 || !cursor.every(Number.isFinite) || !Number.isInteger(cursor[1])) return c.json({ error: "Invalid cursor" }, 400);
    filters += ` AND (${sortDate} < ? OR (${sortDate} = ? AND i.id < ?))`;
    binds.push(cursor[0], cursor[0], cursor[1]);
  }
  if (params.q?.trim()) { filters += " AND (i.title LIKE ? OR i.headline LIKE ? OR i.author LIKE ?)"; const q = `%${params.q.trim().slice(0, 200)}%`; binds.push(q, q, q); }
  if (params.platform) { filters += " AND i.platform=?"; binds.push(params.platform); }
  if (params.saved === "true") filters += " AND ui.id IS NOT NULL";
  // The feed never selects/transmits the walkthrough or full Markdown.
  const rows = await all<BulletinRow>(c.env.DB.prepare(
    `SELECT ${metadata}, ${shortSummarySql} AS summary_structured
     ${accessible()} ${filters} ORDER BY ${sortDate} DESC, i.id DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit + 1, params.cursor ? 0 : offset));
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return c.json({ items: page.map((row) => serializeBulletin(row, user.preferred_language || "auto")),
    next_cursor: hasMore && last ? btoa(JSON.stringify([last.sort_date, last.id])) : null,
    next_offset: hasMore ? offset + page.length : null });
});

async function getAccessible(env: AppContext["Bindings"], userId: number, id: number) {
  return first<BulletinRow>(env.DB.prepare(`SELECT ${metadata}, s.structured AS summary_structured, s.markdown AS summary_markdown ${accessible(true)} AND i.id=? LIMIT 1`).bind(userId, userId, userId, id));
}

bulletinRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid item" }, 400);
  const user = c.get("user");
  const row = await getAccessible(c.env, user.id, id);
  if (!row) return c.json({ error: "bulletin not found" }, 404);
  const source = { ...row, summary_markdown: row.summary_markdown || null };
  const cached = await first<ReadingRow>(c.env.DB.prepare("SELECT * FROM reading_summary WHERE item_id=?").bind(id));
  return c.json({ ...serializeBulletin(row, user.preferred_language || "auto", true), reading_summary: readCached(cached, await sourceHash(source)) });
});

bulletinRoutes.post("/:id/reading-summary", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid item" }, 400);
  const row = await getAccessible(c.env, c.get("user").id, id);
  if (!row) return c.json({ error: "bulletin not found" }, 404);
  try {
    const result = await generateReadingSummary(c.env, { ...row, summary_markdown: row.summary_markdown || null });
    return c.json(result, result.status === "processing" ? 202 : 200);
  } catch (error) {
    console.error("reading summary failed", id, String(error));
    return c.json({ error: "The reading summary could not be prepared. The original notes are still available." }, 503);
  }
});
