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
    // Prefer a supported episode/video page over the raw audio enclosure: it
    // carries far richer metadata than the bare media file. In particular a
    // Xiaoyuzhou episode page exposes the FULL show notes (chapters, reference
    // links), whereas the RSS bridge's <description> is just the short intro.
    if (p === "youtube" || p === "bilibili" || p === "xiaoyuzhou") {
      return { url: entry.link, platform: p };
    }
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

  const healedSub = await selfHealSubscriptionFeed(env, sub);
  const feed = await fetchSubscriptionFeed(env, subId, healedSub.feed_url);
  if (!feed) return 0;
  if (!feed.entries.length) {
    await recordEmptyPoll(env, subId);
    return 0;
  }

  try {
    const pollBatch = await selectPollBatch(env, healedSub, feed.entries);
    const enqueued = await enqueueSubscriptionBatch(env, healedSub, feed.title, pollBatch.entries);
    await recordPollSuccess(env, subId, feed, pollBatch.nextSeenGuid, enqueued);
    return enqueued;
  } catch (err) {
    // A post-fetch failure must never throw uncaught: that leaves the poll
    // unrecorded (last_checked_at stays NULL) so the cron re-enqueues it every
    // tick forever. Record it so the reason is visible and the loop stops.
    await recordPollError(env, subId, err);
    return 0;
  }
}

async function selfHealSubscriptionFeed(env: Env, sub: SubscriptionRow): Promise<SubscriptionRow> {
  let healHost = "";
  try { healHost = new URL(sub.feed_url).hostname.toLowerCase(); } catch { /* not a URL */ }
  if (!healHost.endsWith("podcasts.apple.com") && !healHost.endsWith("itunes.apple.com")) return sub;

  const resolved = await resolveFeedUrl(sub.feed_url);
  if (resolved === sub.feed_url) return sub;

  try {
    await env.DB.prepare("UPDATE subscription SET feed_url = ?, platform = ? WHERE id = ?")
      .bind(resolved, detectPlatform(resolved), sub.id)
      .run();
  } catch (e) {
    // UNIQUE(user_id, feed_url) collision (already subscribed to the resolved
    // feed): use it for this poll without persisting.
    console.warn(`subscription ${sub.id} feed_url persist skipped: ${String(e)}`);
  }

  return { ...sub, feed_url: resolved, platform: detectPlatform(resolved) };
}

async function fetchSubscriptionFeed(
  env: Env,
  subId: number,
  feedUrl: string,
): Promise<{ title: string | null; entries: FeedEntry[] } | null> {
  try {
    return await fetchFeed(env, feedUrl);
  } catch (err) {
    await recordPollError(env, subId, err);
    return null;
  }
}

async function recordEmptyPoll(env: Env, subId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE subscription
        SET last_checked_at = ?, last_status = 'empty', last_error = NULL,
            last_entry_count = 0, last_new_count = 0
      WHERE id = ?`,
  )
    .bind(isoNow(), subId)
    .run();
}

interface PollBatch {
  entries: FeedEntry[];
  nextSeenGuid: string | null;
}

async function selectPollBatch(env: Env, sub: SubscriptionRow, entries: FeedEntry[]): Promise<PollBatch> {
  const minPublished = sub.min_published_at; // window cutoff (e.g. last 90 days)
  const lastSeenIndex = sub.last_seen_guid
    ? entries.findIndex((entry) => entry.guid === sub.last_seen_guid)
    : -1;
  const fresh = lastSeenIndex >= 0 ? entries.slice(0, lastSeenIndex) : entries;
  const inWindow = fresh.filter((e) => !minPublished || !e.published || e.published >= minPublished);
  const minDuration = Number(env.SUBSCRIPTION_MIN_DURATION_S || DEFAULT_MIN_DURATION_S);
  const durations = await Promise.all(inWindow.map((e) => entryDuration(e, entryUrl(e).platform)));
  const within = inWindow.filter((_, i) => durations[i] == null || durations[i]! >= minDuration);

  const newestFirstBatch = within.length > MAX_NEW_PER_POLL
    ? within.slice(-MAX_NEW_PER_POLL)
    : within;
  const nextSeenGuid = within.length > MAX_NEW_PER_POLL
    ? newestFirstBatch[0]?.guid ?? null
    : entries[0]?.guid ?? null;

  return { entries: newestFirstBatch.slice().reverse(), nextSeenGuid };
}

async function enqueueSubscriptionBatch(
  env: Env,
  sub: SubscriptionRow,
  feedTitle: string | null,
  entries: FeedEntry[],
): Promise<number> {
  let enqueued = 0;
  for (const entry of entries) {
    const { url, platform } = entryUrl(entry);
    if (!url) continue;
    try {
      const addResult = await addUrlToLibrary(env, sub.user_id, url, {
        title: entry.title,
        external_id: entry.guid,
        platform,
        subscriptionId: sub.id,
        feedUrl: sub.feed_url,
        meta: {
          title: entry.title,
          description: entry.description ?? null,
          published_at: entry.published ?? null,
          duration_s: entry.duration_s ?? null,
          thumbnail: entry.thumbnail ?? null,
          author: entry.author ?? feedTitle ?? null,
        },
      });
      if (addResult) enqueued++;
    } catch (err) {
      // One bad entry (e.g. a transient metadata/DB error) shouldn't abort the
      // whole poll; skip it and keep going so the rest of the batch lands.
      console.error("subscription enqueue failed", sub.id, url, String(err));
    }
  }
  return enqueued;
}

async function recordPollSuccess(
  env: Env,
  subId: number,
  feed: { title: string | null; entries: FeedEntry[] },
  nextSeenGuid: string | null,
  enqueued: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE subscription
        SET last_checked_at = ?, last_seen_guid = COALESCE(?, last_seen_guid),
            title = COALESCE(title, ?), last_status = 'ok', last_error = NULL,
            last_entry_count = ?, last_new_count = ?, consecutive_failures = 0
      WHERE id = ?`,
  )
    .bind(isoNow(), nextSeenGuid, feed.title, feed.entries.length, enqueued, subId)
    .run();
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
