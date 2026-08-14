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
// their duration and publish date. Each lookup is a container call, and the
// batch below only needs MAX_NEW_PER_POLL survivors, so the walk normally stops
// long before this; the cap only bounds a first poll of a channel that is
// mostly clips.
const MAX_SOURCE_LOOKUPS = 16;
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
// without this neither the duration floor nor the publish window applied to
// them: 47-second clips and six-year-old uploads both went through the full
// download + transcribe. One metadata call is far cheaper than the run it
// prevents. Limited to platforms whose metadata is a cheap lookup — an RSS
// enclosure would mean fetching the audio itself.
const SOURCE_FACT_PLATFORMS = new Set(["bilibili", "youtube"]);

async function sourceMetadata(env: Env, url: string, platform: string) {
  if (!SOURCE_FACT_PLATFORMS.has(platform)) return null;
  try {
    const { fetchMetadata } = await import("./container");
    return await fetchMetadata(env, url, platform);
  } catch (err) {
    // An unresolved entry is kept: a flaky lookup must not silently drop
    // episodes a channel really published.
    console.warn("subscription entry lookup failed", url, String(err));
    return null;
  }
}

interface EntryFacts {
  durationS: number | null;
  published: string | null;
}

// What the feed said about an entry, filled in from the source where it was
// silent. Both facts come from one lookup.
async function entryFacts(
  env: Env,
  entry: FeedEntry,
  platform: string,
  url: string | null,
): Promise<EntryFacts> {
  let durationS = entry.duration_s ?? null;
  const published = entry.published ?? null;
  if (durationS == null && platform === "youtube") {
    durationS = await youtubeDuration(entry.link);
  }
  if ((durationS == null || published == null) && url) {
    const metadata = await sourceMetadata(env, url, platform);
    return {
      durationS: durationS ?? metadata?.duration_s ?? null,
      published: published ?? metadata?.published_at ?? null,
    };
  }
  return { durationS, published };
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

  // A dated feed is consumed OLDEST first and the cursor stops at the newest
  // entry taken, so successive polls walk forward through the backfill window.
  // A feed with no dates at all (Bilibili's flat enumeration) can't be windowed
  // that way — walking from the old end would just replay 2020 uploads — so it
  // is read newest first and each candidate is resolved at the source until one
  // falls outside the window.
  const undated = inWindow.length > 0 && inWindow.every((entry) => !entry.published);
  const batch: FeedEntry[] = [];
  let lookups = 0;
  let leftover = false;
  let unresolved = false;
  for (const entry of undated ? inWindow : inWindow.slice().reverse()) {
    let facts: EntryFacts = {
      durationS: entry.duration_s ?? null,
      published: entry.published ?? null,
    };
    const looked = (facts.durationS == null || facts.published == null)
      && lookups < MAX_SOURCE_LOOKUPS;
    if (looked) {
      lookups++;
      const { url, platform } = entryUrl(entry);
      facts = await entryFacts(env, entry, platform, url);
    }
    if (undated) {
      // Nothing to go on: the entry can be neither windowed nor measured. A
      // failed lookup (the container is busy) is worth another poll, an
      // exhausted budget is not.
      if (looked && facts.published == null) {
        unresolved = true;
        break;
      }
      if (!looked && facts.published == null) break;
      if (minPublished && facts.published && facts.published < minPublished) break;
    }
    if (facts.durationS != null && facts.durationS < minDuration) continue;
    if (batch.length === MAX_NEW_PER_POLL) {
      leftover = true;
      break;
    }
    batch.push(entry);
  }

  // An undated feed has had everything the window could contain considered, so
  // the cursor jumps to the newest entry and later polls only see fresh uploads
  // (a channel that published more than one batch since the follow started
  // keeps the newest of them). A null cursor leaves the follow where it was, so
  // entries the source refused to describe are reconsidered next time.
  if (undated) {
    return {
      entries: batch.reverse(),
      nextSeenGuid: unresolved ? null : entries[0]?.guid ?? null,
    };
  }
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
