import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";
import { readJson } from "../lib/request";

// Per-user comments + highlights, plus a unified cross-item annotations feed.
// This router is mounted at the broad "/api" prefix (to own both
// /api/items/:id/... and /api/annotations), so auth is applied per-route rather
// than via a wildcard middleware — a wildcard here would gate every /api/* path
// (e.g. the public /api/items catalog).
export const annotationRoutes = new Hono<AppContext>();

interface AnnotationItem {
  id: number;
  title: string | null;
  platform: string;
  source_url: string;
  author: string | null;
  thumbnail: string | null;
}

interface HighlightAnnotationRow extends AnnotationItem {
  item_id: number;
  quote: string;
  source: string;
  color: string;
  note: string;
  created_at: string;
}

interface CommentAnnotationRow extends AnnotationItem {
  item_id: number;
  body: string;
  created_at: string;
}

type AnnotationFeedRow =
  | {
      kind: "highlight";
      id: number;
      item: AnnotationItem;
      created_at: string;
      quote: string;
      source: string;
      color: string;
      body: string;
    }
  | {
      kind: "comment";
      id: number;
      item: AnnotationItem;
      created_at: string;
      body: string;
    };

// --- Comments ------------------------------------------------------------
annotationRoutes.post("/items/:id/comments", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const itemId = Number(c.req.param("id"));
  const body = await readJson<{ body?: string }>(c);
  const text = (body.body || "").trim();
  if (!text) return c.json({ error: "empty comment" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO comment (item_id, user_id, body) VALUES (?, ?, ?)",
  ).bind(itemId, userId, text).run();
  const row = await first(c.env.DB.prepare("SELECT * FROM comment WHERE id = ?").bind(res.meta.last_row_id));
  return c.json(row);
});

annotationRoutes.delete("/items/:id/comments/:commentId", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const commentId = Number(c.req.param("commentId"));
  await c.env.DB.prepare("DELETE FROM comment WHERE id = ? AND user_id = ?").bind(commentId, userId).run();
  return c.json({ ok: true });
});

// --- Highlights ----------------------------------------------------------
annotationRoutes.post("/items/:id/highlights", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const itemId = Number(c.req.param("id"));
  const body = await readJson<{
    quote?: string;
    source?: string;
    note?: string;
    color?: string;
    prefix?: string;
    suffix?: string;
  }>(c);
  const quote = (body.quote || "").trim();
  if (!quote) return c.json({ error: "empty highlight" }, 400);
  const res = await c.env.DB.prepare(
    `INSERT INTO highlight (item_id, user_id, source, quote, note, color, prefix, suffix)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(itemId, userId, body.source || "summary", quote, (body.note || "").trim(), body.color || "yellow", body.prefix || "", body.suffix || "")
    .run();
  const row = await first(c.env.DB.prepare("SELECT * FROM highlight WHERE id = ?").bind(res.meta.last_row_id));
  return c.json(row);
});

annotationRoutes.patch("/items/:id/highlights/:hid", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const hid = Number(c.req.param("hid"));
  const body = await readJson<{ note?: string; color?: string }>(c);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.note !== undefined) {
    sets.push("note = ?");
    binds.push(body.note.trim());
  }
  if (body.color !== undefined) {
    sets.push("color = ?");
    binds.push(body.color);
  }
  if (sets.length) {
    binds.push(hid, userId);
    await c.env.DB.prepare(`UPDATE highlight SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  }
  const row = await first(c.env.DB.prepare("SELECT * FROM highlight WHERE id = ? AND user_id = ?").bind(hid, userId));
  if (!row) return c.json({ error: "highlight not found" }, 404);
  return c.json(row);
});

annotationRoutes.delete("/items/:id/highlights/:hid", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const hid = Number(c.req.param("hid"));
  await c.env.DB.prepare("DELETE FROM highlight WHERE id = ? AND user_id = ?").bind(hid, userId).run();
  return c.json({ ok: true });
});

// --- Unified cross-item feed --------------------------------------------
annotationRoutes.get("/annotations", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const kind = c.req.query("kind");
  const itemId = c.req.query("item_id");
  const rows: AnnotationFeedRow[] = [];

  if (kind !== "comment") {
    const where = ["h.user_id = ?"];
    const binds: unknown[] = [userId];
    if (itemId) {
      where.push("h.item_id = ?");
      binds.push(Number(itemId));
    }
    const highlights = await all<HighlightAnnotationRow>(
      c.env.DB.prepare(
        `SELECT h.id, h.item_id, h.quote, h.source, h.color, h.note, h.created_at,
                i.title, i.platform, i.source_url, i.author, i.thumbnail
           FROM highlight h JOIN item i ON i.id = h.item_id
           WHERE ${where.join(" AND ")}`,
      ).bind(...binds),
    );
    for (const highlight of highlights)
      rows.push({
        kind: "highlight",
        id: highlight.id,
        item: {
          id: highlight.item_id,
          title: highlight.title,
          platform: highlight.platform,
          source_url: highlight.source_url,
          author: highlight.author,
          thumbnail: highlight.thumbnail,
        },
        created_at: highlight.created_at,
        quote: highlight.quote,
        source: highlight.source,
        color: highlight.color,
        body: highlight.note,
      });
  }
  if (kind !== "highlight") {
    const where = ["cm.user_id = ?"];
    const binds: unknown[] = [userId];
    if (itemId) {
      where.push("cm.item_id = ?");
      binds.push(Number(itemId));
    }
    const comments = await all<CommentAnnotationRow>(
      c.env.DB.prepare(
        `SELECT cm.id, cm.item_id, cm.body, cm.created_at,
                i.title, i.platform, i.source_url, i.author, i.thumbnail
           FROM comment cm JOIN item i ON i.id = cm.item_id
           WHERE ${where.join(" AND ")}`,
      ).bind(...binds),
    );
    for (const comment of comments)
      rows.push({
        kind: "comment",
        id: comment.id,
        item: {
          id: comment.item_id,
          title: comment.title,
          platform: comment.platform,
          source_url: comment.source_url,
          author: comment.author,
          thumbnail: comment.thumbnail,
        },
        created_at: comment.created_at,
        body: comment.body,
      });
  }
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return c.json(rows);
});
