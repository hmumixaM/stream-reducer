import {
  rssBulletins,
  feedCursorFilter,
  type FeedCursor,
} from "../lib/rssBulletin";
import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth, resolveUser } from "../auth";
import { all, first } from "../db";
import { itemChannel } from "../lib/itemChannel";
import {
  generateReadingSummary,
  readCached,
  sourceHash,
  type ReadingRow,
} from "../lib/readingSummary";

import {
  serializeBulletin,
  type BulletinRow,
  bulletinMetadata as metadata,
  bulletinSortDate as sortDate,
  shortSummarySql,
} from "../lib/bulletinPresentation";
export {
  parseObject,
  parsePoints,
  serializeBulletin,
} from "../lib/bulletinPresentation";

export const bulletinRoutes = new Hono<AppContext>();

// EXISTS avoids duplicating large summary rows across the many-to-many channel joins.
const accessible = (
  includeCollections = false,
) => `FROM item i JOIN summary s ON s.item_id=i.id
  LEFT JOIN user_item ui ON ui.item_id=i.id AND ui.user_id=?
  LEFT JOIN bulletin_translation bt ON bt.item_id=i.id AND bt.lang=?
  WHERE i.status='done' AND (ui.id IS NOT NULL
    OR EXISTS (SELECT 1 FROM subscription sub JOIN channel_item ci ON ci.channel_id=sub.channel_id
      WHERE sub.user_id=? AND sub.enabled=1 AND ci.item_id=i.id)
    OR EXISTS (SELECT 1 FROM subscription sub JOIN item_feed f ON f.feed_url=sub.feed_url
      WHERE sub.user_id=? AND sub.enabled=1 AND f.item_id=i.id)
    ${includeCollections ? "OR EXISTS (SELECT 1 FROM collection_item ci JOIN collection c ON c.id=ci.collection_id WHERE ci.item_id=i.id AND c.is_public=1)" : ""})`;

bulletinRoutes.get("/feed", requireAuth, async (c) => {
  const params = c.req.query();
  const limit = Math.min(Math.max(Number(params.limit || 24), 1), 60);
  const offset = Math.min(Math.max(Number(params.offset || 0), 0), 10000);
  if (!Number.isInteger(limit) || !Number.isInteger(offset))
    return c.json({ error: "Invalid pagination" }, 400);
  const user = c.get("user");
  let cursor: FeedCursor | undefined;
  if (params.cursor) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(atob(params.cursor));
    } catch {
      return c.json({ error: "Invalid cursor" }, 400);
    }
    if (
      !Array.isArray(parsed) ||
      ![2, 3].includes(parsed.length) ||
      !parsed.every(Number.isFinite)
    )
      return c.json({ error: "Invalid cursor" }, 400);
    // Older media-only clients used [date,id].
    cursor =
      parsed.length === 2 ? [parsed[0], 0, parsed[1]] : (parsed as FeedCursor);
    if (
      ![0, 1].includes(cursor[1]) ||
      !Number.isInteger(cursor[2]) ||
      cursor[2] <= 0
    )
      return c.json({ error: "Invalid cursor" }, 400);
  }
  if (
    params.source &&
    (!Number.isSafeInteger(Number(params.source)) || Number(params.source) <= 0)
  )
    return c.json({ error: "Invalid source" }, 400);
  const after = feedCursorFilter(sortDate, "i.id", 0, cursor);
  const binds: unknown[] = [user.id, user.preferred_language || "auto", user.id, user.id, ...after.binds];
  let filters = after.sql;
  if (params.q?.trim()) {
    filters += " AND (i.title LIKE ? OR i.headline LIKE ? OR i.author LIKE ?)";
    const q = `%${params.q.trim().slice(0, 200)}%`;
    binds.push(q, q, q);
  }
  if (params.platform) {
    filters += " AND i.platform=?";
    binds.push(params.platform);
  }
  if (params.saved === "true") filters += " AND ui.id IS NOT NULL";
  const skip = cursor ? 0 : offset;
  const count = skip + limit + 1;
  // Each side returns enough candidates for one globally sorted page. No full
  // notes or article explanations are transferred into this card response.
  const [media, articles] = await Promise.all([
    params.platform === "article" || params.source
      ? []
      : all<BulletinRow>(
          c.env.DB.prepare(
            `SELECT ${metadata}, ${shortSummarySql} AS summary_structured
       ${accessible()} ${filters} ORDER BY ${sortDate} DESC,i.id DESC LIMIT ?`,
          ).bind(...binds, count),
        ),
    rssBulletins(
      c.env,
      user.id,
      user.preferred_language || "auto",
      params,
      count,
      cursor,
    ),
  ]);
  const candidates = [
    ...media.map((row) => ({
      sort_date: row.sort_date,
      rank: 0,
      item: {
        ...serializeBulletin(row, user.preferred_language || "auto"),
        content_type: "media" as const,
      },
    })),
    ...articles,
  ].sort(
    (a, b) =>
      b.sort_date - a.sort_date || b.rank - a.rank || b.item.id - a.item.id,
  );
  const hasMore = candidates.length > skip + limit;
  const page = candidates.slice(skip, skip + limit);
  const last = page.at(-1);
  return c.json({
    items: page.map((row) => row.item),
    next_cursor:
      hasMore && last
        ? btoa(JSON.stringify([last.sort_date, last.rank, last.item.id]))
        : null,
    next_offset: hasMore ? offset + page.length : null,
  });
});

async function getAccessible(
  env: AppContext["Bindings"],
  userId: number,
  id: number,
) {
  return first<BulletinRow>(
    env.DB.prepare(
      `SELECT ${metadata}, s.structured AS summary_structured, s.markdown AS summary_markdown ${accessible(true)} AND i.id=? LIMIT 1`,
    ).bind(userId, "auto", userId, userId, id),
  );
}

bulletinRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ error: "Invalid item" }, 400);
  const user = await resolveUser(c.env, c);
  // Finished bulletins are public reading, same as the item page. The personal
  // feed and any generation stay behind a session.
  const row = await first<BulletinRow>(
    c.env.DB.prepare(
      `SELECT ${metadata}, s.structured AS summary_structured, s.markdown AS summary_markdown
     FROM item i JOIN summary s ON s.item_id=i.id
     LEFT JOIN user_item ui ON ui.item_id=i.id AND ui.user_id=?
     LEFT JOIN bulletin_translation bt ON bt.item_id=i.id AND bt.lang=?
     WHERE i.status='done' AND i.id=? LIMIT 1`,
    ).bind(user?.id ?? -1, user?.preferred_language || "auto", id),
  );
  if (!row) return c.json({ error: "bulletin not found" }, 404);
  const source = { ...row, summary_markdown: row.summary_markdown || null };
  const hash = await sourceHash(source);
  const cached = await first<ReadingRow>(
    c.env.DB.prepare("SELECT * FROM reading_summary WHERE item_id=?").bind(id),
  );
  const chinese = await first<ReadingRow>(
    c.env.DB.prepare(
      "SELECT * FROM reading_summary_lang WHERE item_id=? AND lang='zh'",
    ).bind(id),
  );
  const english = await first<ReadingRow>(c.env.DB.prepare("SELECT * FROM reading_summary_lang WHERE item_id=? AND lang='en'").bind(id));
  const contentTranslations = await all<{ lang: string; status: string }>(
    c.env.DB.prepare(
      "SELECT lang, status FROM item_translation WHERE item_id = ? ORDER BY lang",
    ).bind(id),
  );
  return c.json({
    ...serializeBulletin(row, user?.preferred_language || "auto", true),
    reading_summary: readCached(cached, hash),
    reading_summary_zh: readCached(chinese, hash),
    reading_summary_en: readCached(english, hash),
    content_translations: contentTranslations,
    channel: await itemChannel(c.env, id),
  });
});

bulletinRoutes.post("/:id/reading-summary", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0)
    return c.json({ error: "Invalid item" }, 400);
  const row = await getAccessible(c.env, c.get("user").id, id);
  if (!row) return c.json({ error: "bulletin not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { lang?: string };
  const lang = body.lang === "zh" || body.lang === "en" ? body.lang : "";
  try {
    const result = await generateReadingSummary(
      c.env,
      { ...row, summary_markdown: row.summary_markdown || null },
      lang,
    );
    return c.json(result, result.status === "processing" ? 202 : 200);
  } catch (error) {
    console.error("reading summary failed", id, String(error));
    return c.json(
      {
        error:
          "The reading summary could not be prepared. The original notes are still available.",
      },
      503,
    );
  }
});
