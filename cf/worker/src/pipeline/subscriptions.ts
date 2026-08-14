import type { Env } from "../env";
import { first, type ChannelFollowRow, type ChannelRow } from "../db";
import {
  isHostOrSubdomain,
  resolveChannelIdentity,
  upsertChannel,
} from "../lib/channels";
import { isoNow } from "../lib/crypto";
import { addUrlToLibrary } from "../lib/ingest";
import { detectPlatform } from "../lib/url";
import { fetchFeed, resolveFeedUrl, type FeedEntry } from "../lib/feed";
import { errorMessage, isTransientCapacity } from "./transient";

const MAX_NEW_PER_POLL = 10;
// Subscriptions skip videos shorter than this (avoids flooding a library with
// shorts/clips). Manual adds are NOT affected. Override with env.
const DEFAULT_MIN_DURATION_S = 300;
// Ceiling on how many entries a single poll may look up at the source to learn
// their duration. Each lookup is a container call, and the batch below only
// needs MAX_NEW_PER_POLL survivors, so the walk normally stops long before
// this; the cap only bounds a first poll of a channel that is mostly clips.
const MAX_DURATION_LOOKUPS = 16;
const YT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type PollSubscriptionRow = ChannelFollowRow & {
  channel_feed_url: ChannelRow["feed_url"] | null;
  channel_title: ChannelRow["title"];
  channel_image_url: ChannelRow["image_url"];
};

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

// Ask the pipeline container what a video actually is. Bilibili channels are
// enumerated by a flat yt-dlp extraction that returns ids and nothing else, so
// without this the duration floor never applied to them and 47-second clips
// went through the full download + transcribe. One metadata call is far cheaper
// than the run it prevents. Limited to platforms whose metadata is a cheap
// lookup — an RSS enclosure would mean fetching the audio itself.
const SOURCE_DURATION_PLATFORMS = new Set(["bilibili", "youtube"]);

async function sourceDuration(env: Env, url: string, platform: string): Promise<number | null> {
  if (!SOURCE_DURATION_PLATFORMS.has(platform)) return null;
  try {
    const { fetchMetadata } = await import("./container");
    const metadata = await fetchMetadata(env, url, platform);
    return metadata?.duration_s ?? null;
  } catch (err) {
    // Unknown duration means "keep it": a flaky lookup must not silently drop
    // episodes a channel really published.
    console.warn("subscription duration lookup failed", url, String(err));
    return null;
  }
}

// Best-effort duration (seconds) for a feed entry; null when unknown.
async function entryDuration(
  env: Env,
  entry: FeedEntry,
  platform: string,
  url: string | null,
): Promise<number | null> {
  if (entry.duration_s != null) return entry.duration_s;
  if (platform === "youtube") {
    const scraped = await youtubeDuration(entry.link);
    if (scraped != null) return scraped;
  }
  return url ? sourceDuration(env, url, platform) : null;
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
  const sub = await first<PollSubscriptionRow>(
    env.DB.prepare(
      `SELECT subscription.*,
              channel.feed_url AS channel_feed_url,
              channel.title AS channel_title,
              channel.image_url AS channel_image_url
         FROM subscription
         LEFT JOIN channel ON channel.id = subscription.channel_id
        WHERE subscription.id = ?`,
    ).bind(subId),
  );
  if (!sub) return 0;

  const healedSub = await selfHealSubscriptionFeed(env, sub);
  const feed = await fetchSubscriptionFeed(
    env,
    subId,
    healedSub.channel_feed_url ?? healedSub.feed_url,
  );
  if (!feed) return 0;
  if (!feed.entries.length) {
    await recordEmptyPoll(env, subId);
    return 0;
  }

  try {
    const pollBatch = await selectPollBatch(env, healedSub, feed.entries);
    const ingest = await enqueueSubscriptionBatch(
      env,
      healedSub,
      feed.title,
      pollBatch.entries,
    );
    await recordPollSuccess(
      env,
      healedSub,
      feed,
      ingest.failed ? ingest.nextSeenGuid : pollBatch.nextSeenGuid,
      ingest.enqueued,
    );
    if (ingest.failed) await recordPollError(env, subId, ingest.error);
    return ingest.enqueued;
  } catch (err) {
    // A post-fetch failure must never throw uncaught: that leaves the poll
    // unrecorded (last_checked_at stays NULL) so the cron re-enqueues it every
    // tick forever. Record it so the reason is visible and the loop stops.
    await recordPollError(env, subId, err);
    return 0;
  }
}

async function selfHealSubscriptionFeed(
  env: Env,
  sub: PollSubscriptionRow,
): Promise<PollSubscriptionRow> {
  const currentFeedUrl = sub.channel_feed_url ?? sub.feed_url;
  let healHost = "";
  try { healHost = new URL(currentFeedUrl).hostname.toLowerCase(); } catch { /* not a URL */ }
  // Re-run resolution for sources whose stored feed_url may be an unpollable
  // PAGE url rather than a canonical feed: Apple show pages, and YouTube channel
  // pages (incl. bare legacy vanity URLs like youtube.com/TheDiaryOfACEO that
  // older code failed to resolve — they polled 0 entries forever). resolveFeedUrl
  // is a cheap no-op for already-canonical feeds (feeds/videos.xml passes through
  // without a network fetch), so this only does work when healing is needed.
  const canHeal =
    isHostOrSubdomain(healHost, "podcasts.apple.com") ||
    isHostOrSubdomain(healHost, "itunes.apple.com") ||
    isHostOrSubdomain(healHost, "youtube.com") ||
    isHostOrSubdomain(healHost, "youtube-nocookie.com");
  if (!canHeal) return sub;

  const resolved = await resolveFeedUrl(currentFeedUrl);
  if (resolved === currentFeedUrl) return sub;

  if (sub.channel_id != null) {
    const identity = await resolveChannelIdentity(resolved);
    const channel = await upsertChannel(env, identity, {
      title: sub.channel_title,
      imageUrl: sub.channel_image_url,
    });
    try {
      await env.DB.prepare("UPDATE subscription SET channel_id = ? WHERE id = ?")
        .bind(channel.id, sub.id)
        .run();
    } catch (err) {
      // A user may already follow the canonical channel. Keep this poll useful
      // and link its discovered items to the canonical channel; the migration
      // merge will reconcile the duplicate legacy follow.
      console.warn(`subscription ${sub.id} channel persist skipped: ${String(err)}`);
    }
    return {
      ...sub,
      channel_id: channel.id,
      channel_feed_url: channel.feed_url,
      channel_title: channel.title,
      channel_image_url: channel.image_url,
    };
  }

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
    // A container-pool blip (all slots busy, or a cold start reset by
    // blockConcurrencyWhile) says nothing about the feed's health, so don't brand
    // the subscription broken over it — that produced a bogus "last poll failed"
    // with consecutive_failures climbing on perfectly good channels. The aux
    // container call already retried; if it's STILL blipping, leave the poll
    // unrecorded so this subscription stays due and the next cron tick (15 min)
    // picks it up, mirroring how the queue consumer re-queues without burning a
    // retry. Bounded by the cron cadence, so it can't hot-loop.
    const msg = errorMessage(err);
    if (isTransientCapacity(msg)) {
      console.warn(`subscription ${subId} poll deferred — container capacity: ${msg}`);
      return null;
    }
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

async function selectPollBatch(
  env: Env,
  sub: ChannelFollowRow,
  entries: FeedEntry[],
): Promise<PollBatch> {
  const minPublished = sub.min_published_at; // window cutoff (e.g. last 90 days)
  const lastSeenIndex = sub.last_seen_guid
    ? entries.findIndex((entry) => entry.guid === sub.last_seen_guid)
    : -1;
  const fresh = lastSeenIndex >= 0 ? entries.slice(0, lastSeenIndex) : entries;
  const inWindow = fresh.filter((e) => !minPublished || !e.published || e.published >= minPublished);
  const minDuration = Number(env.SUBSCRIPTION_MIN_DURATION_S || DEFAULT_MIN_DURATION_S);

  // A poll takes the OLDEST survivors and remembers the newest of them, so the
  // next tick walks forward in time. Walking in that same order lets the
  // duration checks stop as soon as the batch is full instead of resolving a
  // whole back-catalogue up front.
  const batch: FeedEntry[] = [];
  let lookups = 0;
  let leftover = false;
  for (const entry of inWindow.slice().reverse()) {
    let duration = entry.duration_s ?? null;
    if (duration == null && lookups < MAX_DURATION_LOOKUPS) {
      lookups++;
      const { url, platform } = entryUrl(entry);
      duration = await entryDuration(env, entry, platform, url);
    }
    if (duration != null && duration < minDuration) continue;
    if (batch.length === MAX_NEW_PER_POLL) {
      leftover = true;
      break;
    }
    batch.push(entry);
  }

  // More survivors than one poll takes: resume from the newest one enqueued.
  // Otherwise the whole feed is consumed, so jump the cursor to its newest entry.
  const nextSeenGuid = leftover
    ? batch[batch.length - 1]?.guid ?? null
    : entries[0]?.guid ?? null;

  return { entries: batch, nextSeenGuid };
}

async function enqueueSubscriptionBatch(
  env: Env,
  sub: PollSubscriptionRow,
  feedTitle: string | null,
  entries: FeedEntry[],
): Promise<{
  enqueued: number;
  nextSeenGuid: string | null;
  failed: boolean;
  error: unknown | null;
}> {
  const feedUrl = sub.channel_feed_url ?? sub.feed_url;
  let enqueued = 0;
  let nextSeenGuid = sub.last_seen_guid;
  for (const entry of entries) {
    const { url, platform } = entryUrl(entry);
    if (!url) {
      nextSeenGuid = entry.guid ?? nextSeenGuid;
      continue;
    }
    try {
      const addResult = await addUrlToLibrary(env, sub.user_id, url, {
        title: entry.title,
        external_id: entry.guid,
        platform,
        folderId: sub.folder_id ?? null,
        subscriptionId: sub.id,
        feedUrl,
        channelId: sub.channel_id,
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
      nextSeenGuid = entry.guid ?? nextSeenGuid;
    } catch (err) {
      console.error("subscription enqueue failed", sub.id, url, String(err));
      return { enqueued, nextSeenGuid, failed: true, error: err };
    }
  }
  return { enqueued, nextSeenGuid, failed: false, error: null };
}

async function recordPollSuccess(
  env: Env,
  sub: PollSubscriptionRow,
  feed: { title: string | null; entries: FeedEntry[] },
  nextSeenGuid: string | null,
  enqueued: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE subscription
        SET last_checked_at = ?, last_seen_guid = COALESCE(?, last_seen_guid),
            title = CASE WHEN channel_id IS NULL THEN COALESCE(title, ?) ELSE title END,
            last_status = 'ok', last_error = NULL,
            last_entry_count = ?, last_new_count = ?, consecutive_failures = 0
      WHERE id = ?`,
  )
    .bind(isoNow(), nextSeenGuid, feed.title, feed.entries.length, enqueued, sub.id)
    .run();

  if (sub.channel_id != null) {
    const imageUrl = feed.entries.find((entry) => entry.thumbnail)?.thumbnail ?? null;
    await env.DB.prepare(
      `UPDATE channel
          SET title = COALESCE(NULLIF(?, ''), title),
              image_url = COALESCE(NULLIF(?, ''), image_url),
              updated_at = ?
        WHERE id = ?`,
    )
      .bind(feed.title, imageUrl, isoNow(), sub.channel_id)
      .run();
  }
}

// Cron entrypoint: enqueue polls for every subscription whose interval elapsed.
// Following a channel is what subscribes to it, so every follow is polled.
export async function pollDueSubscriptions(env: Env): Promise<void> {
  const now = Date.now();
  const subs = await env.DB.prepare(
    `SELECT subscription.id, subscription.interval_minutes, subscription.last_checked_at
       FROM subscription
       LEFT JOIN channel ON channel.id = subscription.channel_id
      WHERE COALESCE(channel.feed_url, subscription.feed_url) IS NOT NULL`,
  ).all<{ id: number; interval_minutes: number; last_checked_at: string | null }>();
  for (const s of subs.results ?? []) {
    const last = s.last_checked_at ? new Date(s.last_checked_at).getTime() : 0;
    if (now - last >= s.interval_minutes * 60 * 1000) {
      await env.PIPELINE.send({ kind: "poll", subscription_id: s.id });
    }
  }
}
