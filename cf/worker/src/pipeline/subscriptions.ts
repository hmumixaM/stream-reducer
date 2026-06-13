import type { Env } from "../env";
import { first, type SubscriptionRow } from "../db";
import { isoNow } from "../lib/crypto";
import { addUrlToLibrary } from "../lib/ingest";
import { detectPlatform } from "../lib/url";
import { parseFeed, type FeedEntry } from "../lib/feed";

const MAX_NEW_PER_POLL = 10;

// Pick the best processing URL + platform for a feed entry (prefer a supported
// video page over a raw audio enclosure for richer metadata / native captions).
function entryUrl(entry: FeedEntry): { url: string | null; platform: string } {
  if (entry.link) {
    const p = detectPlatform(entry.link);
    if (p === "youtube" || p === "bilibili") return { url: entry.link, platform: p };
  }
  if (entry.audio) return { url: entry.audio, platform: "rss" };
  return { url: entry.link, platform: entry.link ? detectPlatform(entry.link) : "rss" };
}

export async function pollSubscription(env: Env, subId: number): Promise<number> {
  const sub = await first<SubscriptionRow>(
    env.DB.prepare("SELECT * FROM subscription WHERE id = ?").bind(subId),
  );
  if (!sub || !sub.enabled) return 0;

  let xml = "";
  try {
    const res = await fetch(sub.feed_url, { headers: { "user-agent": "stream-reduce/1.0" } });
    xml = await res.text();
  } catch {
    await env.DB.prepare("UPDATE subscription SET last_checked_at = ? WHERE id = ?").bind(isoNow(), subId).run();
    return 0;
  }
  const feed = parseFeed(xml);
  const entries = feed.entries;
  if (!entries.length) {
    await env.DB.prepare("UPDATE subscription SET last_checked_at = ? WHERE id = ?").bind(isoNow(), subId).run();
    return 0;
  }

  const newestGuid = entries[0].guid;
  // Stop at the last-seen entry; cap the batch to avoid flooding.
  const fresh: FeedEntry[] = [];
  for (const e of entries) {
    if (sub.last_seen_guid && e.guid === sub.last_seen_guid) break;
    fresh.push(e);
  }
  const minPublished = sub.min_published_at; // window cutoff (last 3 months)
  const within = fresh.filter((e) => !minPublished || !e.published || e.published >= minPublished);
  const batch = within.slice(0, MAX_NEW_PER_POLL).reverse(); // oldest first

  let enqueued = 0;
  for (const e of batch) {
    const { url, platform } = entryUrl(e);
    if (!url) continue;
    const res = await addUrlToLibrary(env, sub.user_id, url, {
      title: e.title,
      external_id: e.guid,
      platform,
      subscriptionId: sub.id,
    });
    if (res) enqueued++;
  }

  await env.DB.prepare(
    `UPDATE subscription SET last_checked_at = ?, last_seen_guid = COALESCE(?, last_seen_guid),
       title = COALESCE(title, ?) WHERE id = ?`,
  )
    .bind(isoNow(), newestGuid, feed.title, subId)
    .run();
  return enqueued;
}

// Cron entrypoint: enqueue polls for every subscription whose interval elapsed.
export async function pollDueSubscriptions(env: Env): Promise<void> {
  const now = Date.now();
  const subs = await env.DB.prepare("SELECT id, interval_minutes, last_checked_at FROM subscription WHERE enabled = 1").all<{ id: number; interval_minutes: number; last_checked_at: string | null }>();
  for (const s of subs.results ?? []) {
    const last = s.last_checked_at ? new Date(s.last_checked_at).getTime() : 0;
    if (now - last >= s.interval_minutes * 60 * 1000) {
      await env.PIPELINE.send({ kind: "poll", subscription_id: s.id });
    }
  }
}
