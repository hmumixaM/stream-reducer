import type { Env } from "../env";
import { first, type SubscriptionRow } from "../db";
import { isoNow } from "../lib/crypto";
import { addUrlToLibrary } from "../lib/ingest";
import { detectPlatform } from "../lib/url";
import { fetchFeed, resolveFeedUrl, type FeedEntry } from "../lib/feed";

const MAX_NEW_PER_POLL = 10;
// Subscriptions skip videos shorter than this (avoids flooding a library with
// shorts/clips). Manual adds are NOT affected. Override with env.
const DEFAULT_MIN_DURATION_S = 600;
const YT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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

// YouTube channel feeds carry no duration, so read it from the watch page.
async function youtubeDuration(link: string | null): Promise<number | null> {
  const m = link?.match(/[?&]v=([\w-]{6,})/) || link?.match(/youtu\.be\/([\w-]{6,})/);
  if (!m) return null;
  try {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${m[1]}`, {
      headers: { "user-agent": YT_UA, "accept-language": "en-US,en;q=0.9" },
    })).text();
    const dm = html.match(/"lengthSeconds":"(\d+)"/);
    return dm ? Number(dm[1]) : null;
  } catch {
    return null;
  }
}

// Best-effort duration (seconds) for a feed entry; null when unknown.
async function entryDuration(entry: FeedEntry, platform: string): Promise<number | null> {
  if (entry.duration_s != null) return entry.duration_s;
  if (platform === "youtube") return youtubeDuration(entry.link);
  return null;
}

// Record the outcome of a poll so a broken feed is visible instead of silently
// looking like "healthy, no new episodes". `error` carries the failure reason;
// `consecutive_failures` keeps climbing until a poll succeeds again.
async function recordPollError(env: Env, subId: number, err: unknown): Promise<void> {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error("subscription poll failed", subId, msg);
  await env.DB.prepare(
    `UPDATE subscription
        SET last_checked_at = ?, last_status = 'error', last_error = ?,
            consecutive_failures = consecutive_failures + 1
      WHERE id = ?`,
  )
    .bind(isoNow(), msg.slice(0, 2000), subId)
    .run();
}

export async function pollSubscription(env: Env, subId: number): Promise<number> {
  const sub = await first<SubscriptionRow>(
    env.DB.prepare("SELECT * FROM subscription WHERE id = ?").bind(subId),
  );
  if (!sub || !sub.enabled) return 0;

  // Self-heal: an Apple Podcasts show URL still stored as feed_url means the
  // iTunes lookup failed when the subscription was created (Apple rate-limits
  // the Worker egress). Re-resolve to the real RSS feed now and persist it, so a
  // transient creation-time failure doesn't leave the subscription permanently
  // stuck returning zero entries.
  let healHost = "";
  try { healHost = new URL(sub.feed_url).hostname.toLowerCase(); } catch { /* not a URL */ }
  if (healHost.endsWith("podcasts.apple.com") || healHost.endsWith("itunes.apple.com")) {
    const resolved = await resolveFeedUrl(sub.feed_url);
    if (resolved !== sub.feed_url) {
      console.log(`subscription ${subId} feed_url self-healed: ${sub.feed_url} -> ${resolved}`);
      try {
        await env.DB.prepare("UPDATE subscription SET feed_url = ?, platform = ? WHERE id = ?")
          .bind(resolved, detectPlatform(resolved), subId)
          .run();
      } catch (e) {
        // UNIQUE(user_id, feed_url) collision (already subscribed to the resolved
        // feed): use it for this poll without persisting.
        console.warn(`subscription ${subId} feed_url persist skipped: ${String(e)}`);
      }
      sub.feed_url = resolved;
    }
  }

  let feed: { title: string | null; entries: FeedEntry[] };
  try {
    feed = await fetchFeed(env, sub.feed_url);
  } catch (err) {
    await recordPollError(env, subId, err);
    return 0;
  }
  const entries = feed.entries;
  if (!entries.length) {
    // No entries can mean an empty feed OR a feed that fetched but parsed to
    // nothing (e.g. bilibili risk-control HTML). Flag it as 'empty' so the UI
    // can warn when a feed that should have content keeps returning zero.
    await env.DB.prepare(
      `UPDATE subscription
          SET last_checked_at = ?, last_status = 'empty', last_error = NULL,
              last_entry_count = 0, last_new_count = 0
        WHERE id = ?`,
    )
      .bind(isoNow(), subId)
      .run();
    return 0;
  }

  const newestGuid = entries[0].guid;
  // Stop at the last-seen entry; cap the batch to avoid flooding.
  const fresh: FeedEntry[] = [];
  for (const e of entries) {
    if (sub.last_seen_guid && e.guid === sub.last_seen_guid) break;
    fresh.push(e);
  }
  // Two subscription filters: (1) the publish-date window (天数限制) so a channel
  // only backfills its last N days, and (2) the duration floor (default 10 min)
  // so shorts/clips stay out. A subscription pulls EVERY video that passes both
  // — not just the channel feed's latest 15 — drained MAX_NEW_PER_POLL per poll.
  // Entries with an unknown publish date / duration are kept (we can't tell).
  // Manual adds don't go through here, so they're unaffected.
  const minPublished = sub.min_published_at; // window cutoff (e.g. last 90 days)
  const inWindow = fresh.filter((e) => !minPublished || !e.published || e.published >= minPublished);
  const minDuration = Number(env.SUBSCRIPTION_MIN_DURATION_S || DEFAULT_MIN_DURATION_S);
  const durations = await Promise.all(inWindow.map((e) => entryDuration(e, entryUrl(e).platform)));
  const within = inWindow.filter((_, i) => durations[i] == null || durations[i]! >= minDuration);

  // Drain the backfill window from oldest -> newest. When the window is larger
  // than one poll batch, move last_seen_guid only up to the newest item actually
  // processed so later polls continue with the remaining recent entries.
  const newestFirstBatch = within.length > MAX_NEW_PER_POLL
    ? within.slice(-MAX_NEW_PER_POLL)
    : within;
  const batch = newestFirstBatch.slice().reverse(); // oldest first

  let enqueued = 0;
  for (const e of batch) {
    const { url, platform } = entryUrl(e);
    if (!url) continue;
    const res = await addUrlToLibrary(env, sub.user_id, url, {
      title: e.title,
      external_id: e.guid,
      platform,
      subscriptionId: sub.id,
      feedUrl: sub.feed_url,
      // Carry the feed's episode metadata so podcasts keep their title, show
      // notes, date, and artwork even when the audio URL has none.
      meta: {
        title: e.title,
        description: e.description ?? null,
        published_at: e.published ?? null,
        duration_s: e.duration_s ?? null,
        thumbnail: e.thumbnail ?? null,
        // Show/program name (feed title) when the episode carries no author, so
        // the summary knows which program it belongs to.
        author: e.author ?? feed.title ?? null,
      },
    });
    if (res) enqueued++;
  }

  const nextSeenGuid = within.length > MAX_NEW_PER_POLL
    ? newestFirstBatch[0]?.guid
    : newestGuid;
  await env.DB.prepare(
    `UPDATE subscription
        SET last_checked_at = ?, last_seen_guid = COALESCE(?, last_seen_guid),
            title = COALESCE(title, ?), last_status = 'ok', last_error = NULL,
            last_entry_count = ?, last_new_count = ?, consecutive_failures = 0
      WHERE id = ?`,
  )
    .bind(isoNow(), nextSeenGuid, feed.title, entries.length, enqueued, subId)
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
