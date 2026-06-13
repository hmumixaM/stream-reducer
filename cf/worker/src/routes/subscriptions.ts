import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first, type SubscriptionRow } from "../db";
import { detectPlatform } from "../lib/url";
import { isoNow } from "../lib/crypto";

export const subscriptionRoutes = new Hono<AppContext>();
subscriptionRoutes.use("*", requireAuth);

function serialize(s: SubscriptionRow) {
  return { ...s, enabled: !!s.enabled };
}

subscriptionRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  const rows = await all<SubscriptionRow>(
    c.env.DB.prepare("SELECT * FROM subscription WHERE user_id = ? ORDER BY created_at DESC").bind(userId),
  );
  return c.json(rows.map(serialize));
});

subscriptionRoutes.post("/", async (c) => {
  const userId = c.get("user").id;
  const b = (await c.req.json().catch(() => ({}))) as {
    feed_url?: string;
    title?: string;
    interval_minutes?: number;
    window_days?: number;
  };
  const feed = (b.feed_url || "").trim();
  if (!feed) return c.json({ error: "feed_url required" }, 400);

  const existing = await first<SubscriptionRow>(
    c.env.DB.prepare("SELECT * FROM subscription WHERE user_id = ? AND feed_url = ?").bind(userId, feed),
  );
  if (existing) return c.json(serialize(existing));

  const windowDays = b.window_days ?? Number(c.env.SUBSCRIPTION_WINDOW_DAYS || "90");
  // New channels only pull in videos published within the window (last 3 months
  // by default), so subscribing doesn't backfill the entire archive.
  const minPublished = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const res = await c.env.DB.prepare(
    `INSERT INTO subscription (user_id, platform, feed_url, title, interval_minutes, window_days, min_published_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(userId, detectPlatform(feed), feed, b.title ?? null, b.interval_minutes ?? 60, windowDays, minPublished)
    .run();
  const row = await first<SubscriptionRow>(
    c.env.DB.prepare("SELECT * FROM subscription WHERE id = ?").bind(res.meta.last_row_id),
  );
  // Poll immediately so the user sees their last-3-months backfill start.
  if (row) await c.env.PIPELINE.send({ kind: "poll", subscription_id: row.id });
  return c.json(serialize(row!));
});

subscriptionRoutes.post("/:id/toggle", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("UPDATE subscription SET enabled = 1 - enabled WHERE id = ? AND user_id = ?").bind(id, userId).run();
  const row = await first<SubscriptionRow>(
    c.env.DB.prepare("SELECT * FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId),
  );
  if (!row) return c.json({ error: "subscription not found" }, 404);
  return c.json(serialize(row));
});

subscriptionRoutes.post("/:id/poll", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  const row = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId),
  );
  if (!row) return c.json({ error: "subscription not found" }, 404);
  await c.env.DB.prepare("UPDATE subscription SET last_checked_at = ? WHERE id = ?").bind(isoNow(), id).run();
  await c.env.PIPELINE.send({ kind: "poll", subscription_id: id });
  return c.json({ ok: true });
});

subscriptionRoutes.delete("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return c.json({ ok: true });
});
