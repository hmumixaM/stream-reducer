import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all } from "../db";
import { embedTexts } from "../lib/embed";

export const searchRoutes = new Hono<AppContext>();
searchRoutes.use("*", requireAuth);

// Semantic search over chunk embeddings via Vectorize. Scoped to the user's
// saved items by default (their personal knowledge); `scope=global` searches
// everything.
searchRoutes.get("/", async (c) => {
  const q = c.req.query("q") || "";
  if (!q.trim()) return c.json([]);
  const k = Math.min(Number(c.req.query("k") || 10), 50);
  const sourceFilter = c.req.query("source");
  const itemFilter = c.req.query("item_id");
  const scope = c.req.query("scope") || "library";
  const userId = c.get("user").id;

  const [qvec] = await embedTexts(c.env, [q]);
  if (!qvec) return c.json([]);

  // Over-fetch so we can post-filter to the user's library / source / item.
  const matches = await c.env.VECTORIZE.query(qvec, { topK: k * 4, returnMetadata: "all" });

  let savedIds: Set<number> | null = null;
  if (scope !== "global") {
    const rows = await all<{ item_id: number }>(
      c.env.DB.prepare("SELECT item_id FROM user_item WHERE user_id = ?").bind(userId),
    );
    savedIds = new Set(rows.map((r) => r.item_id));
  }

  const hits: Record<string, unknown>[] = [];
  for (const m of matches.matches) {
    const chunkId = Number(m.id);
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const itemId = Number(meta.item_id);
    if (savedIds && !savedIds.has(itemId)) continue;
    if (itemFilter && itemId !== Number(itemFilter)) continue;
    if (sourceFilter && meta.source !== sourceFilter) continue;

    const row = await c.env.DB.prepare(
      `SELECT ch.id AS chunk_id, ch.item_id, ch.source, ch.field, ch.text,
              ch.start_s, ch.end_s, i.title, i.source_url, i.platform, i.author
         FROM chunk ch JOIN item i ON i.id = ch.item_id
        WHERE ch.id = ?`,
    ).bind(chunkId).first<Record<string, unknown>>();
    if (!row) continue;
    hits.push({ ...row, score: m.score, deep_link: deepLink(row) });
    if (hits.length >= k) break;
  }
  return c.json(hits);
});

function deepLink(row: Record<string, unknown>): string | null {
  const start = row.start_s as number | null;
  const url = row.source_url as string;
  if (start == null || !url) return null;
  if (row.platform === "youtube" || row.platform === "bilibili") {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}t=${Math.floor(start)}s`;
  }
  return null;
}
