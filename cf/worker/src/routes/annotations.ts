import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";

// Per-user comments + highlights, plus a unified cross-item annotations feed.
export const annotationRoutes = new Hono<AppContext>();
annotationRoutes.use("*", requireAuth);

// --- Comments ------------------------------------------------------------
annotationRoutes.post("/items/:id/comments", async (c) => {
  const userId = c.get("user").id;
  const itemId = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { body?: string };
  const text = (body.body || "").trim();
  if (!text) return c.json({ error: "empty comment" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO comment (item_id, user_id, body) VALUES (?, ?, ?)",
  ).bind(itemId, userId, text).run();
  const row = await first(c.env.DB.prepare("SELECT * FROM comment WHERE id = ?").bind(res.meta.last_row_id));
  return c.json(row);
});

annotationRoutes.delete("/items/:id/comments/:commentId", async (c) => {
  const userId = c.get("user").id;
  const commentId = Number(c.req.param("commentId"));
  await c.env.DB.prepare("DELETE FROM comment WHERE id = ? AND user_id = ?").bind(commentId, userId).run();
  return c.json({ ok: true });
});

// --- Highlights ----------------------------------------------------------
annotationRoutes.post("/items/:id/highlights", async (c) => {
  const userId = c.get("user").id;
  const itemId = Number(c.req.param("id"));
  const b = (await c.req.json().catch(() => ({}))) as {
    quote?: string;
    source?: string;
    note?: string;
    color?: string;
    prefix?: string;
    suffix?: string;
  };
  const quote = (b.quote || "").trim();
  if (!quote) return c.json({ error: "empty highlight" }, 400);
  const res = await c.env.DB.prepare(
    `INSERT INTO highlight (item_id, user_id, source, quote, note, color, prefix, suffix)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(itemId, userId, b.source || "summary", quote, (b.note || "").trim(), b.color || "yellow", b.prefix || "", b.suffix || "")
    .run();
  const row = await first(c.env.DB.prepare("SELECT * FROM highlight WHERE id = ?").bind(res.meta.last_row_id));
  return c.json(row);
});

annotationRoutes.patch("/items/:id/highlights/:hid", async (c) => {
  const userId = c.get("user").id;
  const hid = Number(c.req.param("hid"));
  const b = (await c.req.json().catch(() => ({}))) as { note?: string; color?: string };
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.note !== undefined) {
    sets.push("note = ?");
    binds.push(b.note.trim());
  }
  if (b.color !== undefined) {
    sets.push("color = ?");
    binds.push(b.color);
  }
  if (sets.length) {
    binds.push(hid, userId);
    await c.env.DB.prepare(`UPDATE highlight SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  }
  const row = await first(c.env.DB.prepare("SELECT * FROM highlight WHERE id = ? AND user_id = ?").bind(hid, userId));
  if (!row) return c.json({ error: "highlight not found" }, 404);
  return c.json(row);
});

annotationRoutes.delete("/items/:id/highlights/:hid", async (c) => {
  const userId = c.get("user").id;
  const hid = Number(c.req.param("hid"));
  await c.env.DB.prepare("DELETE FROM highlight WHERE id = ? AND user_id = ?").bind(hid, userId).run();
  return c.json({ ok: true });
});

// --- Unified cross-item feed --------------------------------------------
annotationRoutes.get("/annotations", async (c) => {
  const userId = c.get("user").id;
  const kind = c.req.query("kind");
  const itemId = c.req.query("item_id");
  const rows: Record<string, unknown>[] = [];

  if (kind !== "comment") {
    const where = ["h.user_id = ?"];
    const binds: unknown[] = [userId];
    if (itemId) {
      where.push("h.item_id = ?");
      binds.push(Number(itemId));
    }
    const hs = await all<Record<string, unknown>>(
      c.env.DB.prepare(
        `SELECT h.id, h.item_id, h.quote, h.source, h.color, h.note, h.created_at,
                i.title, i.platform, i.source_url, i.author, i.thumbnail
           FROM highlight h JOIN item i ON i.id = h.item_id
           WHERE ${where.join(" AND ")}`,
      ).bind(...binds),
    );
    for (const h of hs)
      rows.push({
        kind: "highlight",
        id: h.id,
        item: { id: h.item_id, title: h.title, platform: h.platform, source_url: h.source_url, author: h.author, thumbnail: h.thumbnail },
        created_at: h.created_at,
        quote: h.quote,
        source: h.source,
        color: h.color,
        body: h.note,
      });
  }
  if (kind !== "highlight") {
    const where = ["cm.user_id = ?"];
    const binds: unknown[] = [userId];
    if (itemId) {
      where.push("cm.item_id = ?");
      binds.push(Number(itemId));
    }
    const cs = await all<Record<string, unknown>>(
      c.env.DB.prepare(
        `SELECT cm.id, cm.item_id, cm.body, cm.created_at,
                i.title, i.platform, i.source_url, i.author, i.thumbnail
           FROM comment cm JOIN item i ON i.id = cm.item_id
           WHERE ${where.join(" AND ")}`,
      ).bind(...binds),
    );
    for (const cm of cs)
      rows.push({
        kind: "comment",
        id: cm.id,
        item: { id: cm.item_id, title: cm.title, platform: cm.platform, source_url: cm.source_url, author: cm.author, thumbnail: cm.thumbnail },
        created_at: cm.created_at,
        body: cm.body,
      });
  }
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return c.json(rows);
});
