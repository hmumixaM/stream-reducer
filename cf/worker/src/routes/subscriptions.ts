import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first, type ItemRow, type SubscriptionRow, type UserItemRow } from "../db";
import { toItemRead } from "../lib/serialize";
import { detectPlatform } from "../lib/url";
import { isoNow } from "../lib/crypto";
import { recomputePriority } from "../lib/ingest";

export const subscriptionRoutes = new Hono<AppContext>();
subscriptionRoutes.use("*", requireAuth);

function serialize(s: SubscriptionRow) {
  return { ...s, enabled: !!s.enabled };
}

function subscriptionFeedUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  const host = url.hostname.toLowerCase();
  if (host.includes("youtube.com") || host.includes("youtube-nocookie.com")) {
    const channelMatch = url.pathname.match(/^\/channel\/([^/?#]+)/);
    if (channelMatch?.[1]) {
      return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelMatch[1]}`;
    }
  }
  return input;
}

// Subscribing/unsubscribing changes the subscriber-demand signal for every item
// linked to that feed/channel, so recompute their priority scores.
async function recomputeFeedPriorities(c: Parameters<typeof requireAuth>[0], feedUrl: string) {
  const rows = await all<{ item_id: number }>(
    c.env.DB.prepare("SELECT DISTINCT item_id FROM item_feed WHERE feed_url = ?").bind(feedUrl),
  );
  for (const row of rows) await recomputePriority(c.env, row.item_id);
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
  const feed = subscriptionFeedUrl((b.feed_url || "").trim());
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
  await recomputeFeedPriorities(c, feed);
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

subscriptionRoutes.get("/:id/items", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  const sub = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId),
  );
  if (!sub) return c.json({ error: "subscription not found" }, 404);
  const rows = await all<ItemRow & {
    folder_id: number | null;
    group_position: number | null;
    is_favorite: number;
    is_archived: number;
    personal_status: string;
    subscription_id: number | null;
  }>(
    c.env.DB.prepare(
      `SELECT item.*, ui.folder_id, ui.group_position, ui.is_favorite,
              ui.is_archived, ui.personal_status, ui.subscription_id
         FROM user_item ui
         JOIN item ON item.id = ui.item_id
        WHERE ui.user_id = ? AND ui.subscription_id = ?
        ORDER BY item.published_at DESC, ui.added_at DESC
        LIMIT 200`,
    ).bind(userId, id),
  );
  return c.json(rows.map((r) => toItemRead(r, r as unknown as UserItemRow)));
});

subscriptionRoutes.post("/:id/comments", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { body?: string };
  const text = (body.body || "").trim();
  if (!text) return c.json({ error: "empty comment" }, 400);
  const sub = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId),
  );
  if (!sub) return c.json({ error: "subscription not found" }, 404);
  const res = await c.env.DB.prepare(
    "INSERT INTO subscription_comment (subscription_id, user_id, body) VALUES (?, ?, ?)",
  ).bind(id, userId, text).run();
  const row = await first(c.env.DB.prepare("SELECT * FROM subscription_comment WHERE id = ?").bind(res.meta.last_row_id));
  return c.json(row);
});

subscriptionRoutes.post("/:id/highlights", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { quote?: string; note?: string; color?: string };
  const quote = (body.quote || "").trim();
  if (!quote) return c.json({ error: "empty highlight" }, 400);
  const sub = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId),
  );
  if (!sub) return c.json({ error: "subscription not found" }, 404);
  const res = await c.env.DB.prepare(
    "INSERT INTO subscription_highlight (subscription_id, user_id, quote, note, color) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, userId, quote, (body.note || "").trim(), body.color || "yellow").run();
  const row = await first(c.env.DB.prepare("SELECT * FROM subscription_highlight WHERE id = ?").bind(res.meta.last_row_id));
  return c.json(row);
});

subscriptionRoutes.get("/:id/annotations", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  const sub = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId),
  );
  if (!sub) return c.json({ error: "subscription not found" }, 404);
  const comments = await all<Record<string, unknown>>(
    c.env.DB.prepare(
      "SELECT 'comment' AS kind, id, body, NULL AS quote, NULL AS note, NULL AS color, created_at FROM subscription_comment WHERE subscription_id = ? AND user_id = ?",
    ).bind(id, userId),
  );
  const highlights = await all<Record<string, unknown>>(
    c.env.DB.prepare(
      "SELECT 'highlight' AS kind, id, note AS body, quote, note, color, created_at FROM subscription_highlight WHERE subscription_id = ? AND user_id = ?",
    ).bind(id, userId),
  );
  const rows = [...comments, ...highlights];
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return c.json(rows);
});

subscriptionRoutes.delete("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  const row = await first<{ feed_url: string }>(
    c.env.DB.prepare("SELECT feed_url FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId),
  );
  await c.env.DB.prepare("DELETE FROM subscription WHERE id = ? AND user_id = ?").bind(id, userId).run();
  if (row) await recomputeFeedPriorities(c, row.feed_url);
  return c.json({ ok: true });
});
