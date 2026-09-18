import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";
import { generateReadingSummary, readCached, sourceHash, type ReadingRow } from "../lib/readingSummary";

export const bulletinRoutes = new Hono<AppContext>();
bulletinRoutes.use("*", requireAuth);

type Point = { text: string; timestamp: number | null };
type BulletinRow = {
  id: number; title: string | null; headline: string | null; subhead: string | null;
  author: string | null; source_url: string; platform: string; duration_s: number | null;
  published_at: string | null; created_at: string; sort_date: number; saved: number;
  summary_structured: string | null; summary_markdown?: string | null;
  localized_bulletin: string | null; localized_bulletin_status: string | null;
  localized_headline?: string | null; localized_subhead?: string | null; localized_tldr?: string | null;
  localized_updated_at?: string | null;
};

export function parseObject(value: string | null): Record<string, unknown> {
  try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
export function parsePoints(raw: unknown): Point[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (typeof entry === "string") return { text: entry.trim(), timestamp: null };
    if (!entry || typeof entry !== "object") return { text: "", timestamp: null };
    return { text: text(entry.text), timestamp: typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp) && entry.timestamp >= 0 ? entry.timestamp : null };
  }).filter((point) => point.text);
}

export function serializeBulletin(row: BulletinRow, language: string, detail = false) {
  const structured = parseObject(row.summary_structured);
  let points = parsePoints(structured.bulletin);
  let localized = false;
  if (language === "zh" && row.localized_bulletin) {
    try {
      const translated = parsePoints(JSON.parse(row.localized_bulletin || "[]"));
      if (translated.length) { points = translated; localized = true; }
    } catch { /* Leave the Chinese edition pending if a historical translation is corrupt. */ }
  }
  const localizedIntro = localized && Boolean(row.localized_headline?.trim() && row.localized_tldr?.trim());
  const localizationStatus = row.localized_bulletin_status === "processing" && row.localized_updated_at && Date.parse(row.localized_updated_at) < Date.now() - 120_000 ? "error" : row.localized_bulletin_status;
  const keyPoints = parsePoints(structured.key_points);
  if (language === "zh" && !localized) points = [];
  else if (!points.length) points = keyPoints.slice(0, 4);
  const base = {
    id: row.id, title: language === "zh" ? (localizedIntro ? row.localized_headline! : "中文简报整理中") : row.headline || row.title || row.source_url,
    source_title: row.title || row.headline || row.source_url,
    subhead: language === "zh" ? (localizedIntro ? row.localized_subhead || "" : "") : row.subhead, author: row.author, platform: row.platform,
    source_url: row.source_url, duration_s: row.duration_s, published_at: row.published_at,
    created_at: row.created_at, saved: Boolean(row.saved),
    bulletin: points.slice(0, 5).map((point) => point.text),
    bulletin_points: points.slice(0, 5),
    bulletin_language: localized ? "zh" : "original",
    bulletin_overview: language === "zh" ? (localizedIntro ? row.localized_tldr! : "") : text(structured.tldr),
    bulletin_intro_ready: language !== "zh" || localizedIntro,
    localization_status: language === "zh" ? (localizedIntro ? "done" : localizationStatus === "done" ? "missing" : localizationStatus || "missing") : "original",
    // Used only for historical content without bulletin points; no duplicate lead on cards.
    summary: points.length ? "" : language === "zh" ? (localizedIntro ? row.localized_tldr || "" : "") : text(structured.tldr) || text(structured.background),
  };
  if (!detail) return base;
  return {
    ...base, markdown: row.summary_markdown || "", tldr: text(structured.tldr),
    key_points: keyPoints.map((point) => point.text), key_point_details: keyPoints,
    background: text(structured.background), atmosphere: text(structured.atmosphere),
    walkthrough: text(structured.walkthrough),
    quotes: Array.isArray(structured.quotes) ? structured.quotes.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const q = value as Record<string, unknown>;
      return text(q.text) ? [{ text: text(q.text), speaker: text(q.speaker), timestamp: typeof q.timestamp === "number" && Number.isFinite(q.timestamp) && q.timestamp >= 0 ? q.timestamp : null }] : [];
    }) : [],
    entities: Array.isArray(structured.entities) ? [...new Set(structured.entities.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))] : [],
  };
}

// EXISTS avoids duplicating large summary rows across the many-to-many channel joins.
const accessible = `FROM item i JOIN summary s ON s.item_id=i.id
  LEFT JOIN user_item ui ON ui.item_id=i.id AND ui.user_id=?
  LEFT JOIN bulletin_translation bt ON bt.item_id=i.id AND bt.lang='zh'
  WHERE i.status='done' AND (ui.id IS NOT NULL
    OR EXISTS (SELECT 1 FROM subscription sub JOIN channel_item ci ON ci.channel_id=sub.channel_id
      WHERE sub.user_id=? AND sub.enabled=1 AND ci.item_id=i.id)
    OR EXISTS (SELECT 1 FROM subscription sub JOIN item_feed f ON f.feed_url=sub.feed_url
      WHERE sub.user_id=? AND sub.enabled=1 AND f.item_id=i.id))`;
const metadata = `i.id, i.title, i.headline, i.subhead, i.author, i.source_url, i.platform,
  i.duration_s, i.published_at, i.created_at, (ui.id IS NOT NULL) AS saved,
  COALESCE(julianday(i.published_at),julianday(i.created_at),0) AS sort_date,
  bt.bulletin AS localized_bulletin, bt.status AS localized_bulletin_status,
  bt.headline AS localized_headline, bt.subhead AS localized_subhead, bt.tldr AS localized_tldr,
  bt.updated_at AS localized_updated_at`;
const sortDate = "COALESCE(julianday(i.published_at),julianday(i.created_at),0)";

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
  const safe = "CASE WHEN json_valid(s.structured) THEN s.structured ELSE '{}' END";
  const rows = await all<BulletinRow>(c.env.DB.prepare(
    `SELECT ${metadata}, json_object('bulletin',json_extract(${safe},'$.bulletin'),
      'key_points',json_extract(${safe},'$.key_points'),
      'tldr',substr(json_extract(${safe},'$.tldr'),1,900)) AS summary_structured
     ${accessible} ${filters} ORDER BY ${sortDate} DESC, i.id DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit + 1, params.cursor ? 0 : offset));
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return c.json({ items: page.map((row) => serializeBulletin(row, user.preferred_language || "auto")),
    next_cursor: hasMore && last ? btoa(JSON.stringify([last.sort_date, last.id])) : null,
    next_offset: hasMore ? offset + page.length : null });
});

async function getAccessible(env: AppContext["Bindings"], userId: number, id: number) {
  return first<BulletinRow>(env.DB.prepare(`SELECT ${metadata}, s.structured AS summary_structured, s.markdown AS summary_markdown ${accessible} AND i.id=? LIMIT 1`).bind(userId, userId, userId, id));
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
