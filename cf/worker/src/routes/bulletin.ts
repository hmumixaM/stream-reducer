import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";
import { parseBulletin } from "../lib/bulletin";

export const bulletinRoutes = new Hono<AppContext>();
bulletinRoutes.use("*", requireAuth);

type BulletinRow = {
  id: number;
  title: string | null;
  headline: string | null;
  subhead: string | null;
  author: string | null;
  source_url: string;
  published_at: string | null;
  created_at: string;
  summary_markdown: string | null;
  summary_structured: string | null;
  localized_bulletin: string | null;
  localized_bulletin_status: string | null;
};

function parseStructured(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (entry && typeof entry === "object" && "text" in entry) return textValue(entry.text);
    return "";
  }).filter(Boolean).slice(0, limit);
}

function bulletinItems(structured: Record<string, unknown>, row: BulletinRow, preferredLanguage: string): string[] {
  if (preferredLanguage === "zh" && row.localized_bulletin_status === "done") {
    return parseBulletin(row.localized_bulletin);
  }
  return textList(structured.bulletin, 5);
}

function serializeBulletin(row: BulletinRow, preferredLanguage: string) {
  const structured = parseStructured(row.summary_structured);
  const bulletin = bulletinItems(structured, row, preferredLanguage);
  const tldr = textValue(structured.tldr);
  const background = textValue(structured.background);
  return {
    id: row.id,
    title: row.headline || row.title || row.source_url,
    source_title: row.title || row.headline || row.source_url,
    subhead: row.subhead,
    author: row.author,
    source_url: row.source_url,
    published_at: row.published_at,
    created_at: row.created_at,
    markdown: row.summary_markdown || "",
    tldr,
    summary: tldr || background || "A new source has been summarized.",
    bulletin,
    key_points: textList(structured.key_points, 14),
    background,
    atmosphere: textValue(structured.atmosphere),
    walkthrough: textValue(structured.walkthrough),
    quotes: Array.isArray(structured.quotes)
      ? structured.quotes.slice(0, 12).map((quote) => {
        if (!quote || typeof quote !== "object") return null;
        const entry = quote as Record<string, unknown>;
        return {
          text: textValue(entry.text),
          speaker: textValue(entry.speaker),
          timestamp: typeof entry.timestamp === "number" ? entry.timestamp : null,
        };
      }).filter((quote): quote is { text: string; speaker: string; timestamp: number | null } => Boolean(quote?.text))
      : [],
    entities: Array.isArray(structured.entities)
      ? structured.entities.map(String).map((entity) => entity.trim()).filter(Boolean).slice(0, 24)
      : [],
  };
}

const accessibleItems = `
  FROM item i
  JOIN summary s ON s.item_id = i.id
  LEFT JOIN user_item ui ON ui.item_id = i.id AND ui.user_id = ?
  LEFT JOIN channel_item ci ON ci.item_id = i.id
  LEFT JOIN item_feed legacy_feed ON legacy_feed.item_id = i.id
  LEFT JOIN subscription sub
    ON sub.user_id = ? AND sub.enabled = 1
   AND (sub.channel_id = ci.channel_id OR sub.feed_url = legacy_feed.feed_url)
  LEFT JOIN bulletin_translation bt ON bt.item_id = i.id AND bt.lang = 'zh'
  WHERE i.status = 'done' AND (ui.id IS NOT NULL OR sub.id IS NOT NULL)
`;

bulletinRoutes.get("/feed", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 60), 1), 100);
  const offset = Math.min(Math.max(Number(c.req.query("offset") || 0), 0), 10000);
  const userId = c.get("user").id;
  const rows = await all<BulletinRow>(c.env.DB.prepare(
    `SELECT DISTINCT i.id, i.title, i.headline, i.subhead, i.author, i.source_url,
            i.published_at, i.created_at, s.markdown AS summary_markdown,
            s.structured AS summary_structured,
            bt.bulletin AS localized_bulletin, bt.status AS localized_bulletin_status
       ${accessibleItems}
       ORDER BY COALESCE(i.published_at, i.created_at) DESC
       LIMIT ? OFFSET ?`,
  ).bind(userId, userId, limit, offset));
  return c.json({
    items: rows.map((row) => serializeBulletin(row, c.get("user").preferred_language || "auto")),
    next_offset: rows.length === limit ? offset + rows.length : null,
  });
});

bulletinRoutes.get("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  const row = await first<BulletinRow>(c.env.DB.prepare(
    `SELECT DISTINCT i.id, i.title, i.headline, i.subhead, i.author, i.source_url,
            i.published_at, i.created_at, s.markdown AS summary_markdown,
            s.structured AS summary_structured,
            bt.bulletin AS localized_bulletin, bt.status AS localized_bulletin_status
       ${accessibleItems}
         AND i.id = ?
       LIMIT 1`,
  ).bind(userId, userId, id));
  if (!row) return c.json({ error: "bulletin not found" }, 404);
  return c.json(serializeBulletin(row, c.get("user").preferred_language || "auto"));
});
