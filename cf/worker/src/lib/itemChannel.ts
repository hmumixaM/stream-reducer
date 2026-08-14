// Single entry point for "which channel does this item belong to?".
//
// Every path that creates or completes an item (manual add, subscription poll,
// pipeline result, admin backfill) goes through attachItemChannel, so an item can
// never end up with a feed row but no channel — the split that left 337 items
// orphaned and three followed channels looking empty.
import type { Env } from "../env";
import {
  linkChannelItem,
  resolveChannelIdentity,
  upsertChannel,
  type ChannelIdentity,
} from "./channels";
import { fetchXiaoyuzhouPodcastId, fetchYoutubeVideoChannelId } from "./feed";

export const YOUTUBE_CHANNEL_ID_RE = /^UC[0-9A-Za-z_-]{22}$/;
const XIAOYUZHOU_ID_RE = /^[0-9a-f]{24}$/;

// Metadata fields that carry channel attribution, shared by the container's
// metadata payload and the pipeline result.
export interface ChannelHint {
  channel_id?: string | null;
  author?: string | null;
  thumbnail?: string | null;
}

export interface ItemChannelTarget {
  id: number;
  platform: string;
  source_url: string;
}

// Canonical YouTube channel feed URL — the same shape stored for YouTube
// follows, so a manually-added video links to the feed its followers poll. The
// id is validated because the pipeline used to feed Bilibili uploader ids in
// here, producing feed rows that could never match a real channel.
export function youtubeChannelFeed(channelId?: string | null): string | null {
  const id = channelId?.trim();
  return id && YOUTUBE_CHANNEL_ID_RE.test(id)
    ? `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`
    : null;
}

// Link a global item to a feed/channel (idempotent). Powers subscriber demand.
export async function linkItemFeed(env: Env, itemId: number, feedUrl?: string | null): Promise<void> {
  if (!feedUrl) return;
  await env.DB.prepare(
    "INSERT INTO item_feed (item_id, feed_url) VALUES (?, ?) ON CONFLICT(item_id, feed_url) DO NOTHING",
  )
    .bind(itemId, feedUrl)
    .run();
}

function parseUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// An Apple episode URL carries the SHOW id in its path and the episode in `?i=`,
// so dropping the query yields the show page — which resolveFeedUrl turns into
// the show's RSS feed.
export function appleShowUrl(sourceUrl: string): string | null {
  const url = parseUrl(sourceUrl);
  if (!url || !/\/id\d+/.test(url.pathname)) return null;
  return `${url.origin}${url.pathname}`;
}

// The channel URL implied by a platform + already-fetched metadata, without any
// network access. Returns null when this platform/metadata combination carries
// no usable channel identity (rss episodes, missing or malformed ids).
export function channelUrlFromMetadata(
  platform: string,
  sourceUrl: string,
  metadata: ChannelHint | null | undefined,
): string | null {
  const channelId = metadata?.channel_id?.trim() || null;
  switch (platform) {
    case "youtube":
      return youtubeChannelFeed(channelId);
    case "bilibili":
      return channelId && /^\d+$/.test(channelId)
        ? `https://space.bilibili.com/${channelId}`
        : null;
    case "apple_podcast":
      return appleShowUrl(sourceUrl);
    default:
      return null;
  }
}

export interface FeedRowResolution {
  channelUrl: string;
  // Set when the stored feed_url is the pipeline's malformed YouTube template
  // and should be rewritten to this channel's real feed URL.
  repairs?: string;
}

// The channel URL implied by an existing item_feed row. Network-free, so the
// backfill can repair the bulk of the orphans without touching the network.
export function channelUrlFromFeedRow(
  platform: string,
  feedUrl: string,
): FeedRowResolution | null {
  const templateId = feedUrl.match(/[?&]channel_id=([^&]+)/)?.[1];
  if (!templateId) {
    // Any other row is already a real feed/space URL written by a poll.
    return parseUrl(feedUrl) ? { channelUrl: feedUrl } : null;
  }
  if (YOUTUBE_CHANNEL_ID_RE.test(templateId)) {
    return { channelUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${templateId}` };
  }
  // A Bilibili uploader mid stuffed into the YouTube template: read the mid back
  // out and flag the row for repair so it stops shadowing the real feed.
  if (platform === "bilibili" && /^\d+$/.test(templateId)) {
    return { channelUrl: `https://space.bilibili.com/${templateId}`, repairs: feedUrl };
  }
  return null;
}

function xiaoyuzhouIdentity(podcastId: string, sourceUrl: string): ChannelIdentity {
  const showUrl = `https://www.xiaoyuzhoufm.com/podcast/${podcastId}`;
  return {
    platform: "xiaoyuzhou",
    channelKey: podcastId,
    keyKind: "provider_id",
    feedUrl: showUrl,
    // Keep the show page (not the episode) as the channel's own URL.
    sourceUrl: showUrl,
  };
}

// Derive a channel identity from metadata already in hand. `null` means this
// item carries no channel identity yet — the caller decides whether to go back
// to the source for it.
export async function resolveItemChannelIdentity(
  platform: string,
  sourceUrl: string,
  metadata: ChannelHint | null | undefined,
): Promise<ChannelIdentity | null> {
  if (platform === "xiaoyuzhou") {
    const podcastId =
      sourceUrl.match(/\/podcast\/([0-9a-f]{24})/i)?.[1] ??
      (await fetchXiaoyuzhouPodcastId(sourceUrl));
    return podcastId && XIAOYUZHOU_ID_RE.test(podcastId)
      ? xiaoyuzhouIdentity(podcastId.toLowerCase(), sourceUrl)
      : null;
  }
  const channelUrl = channelUrlFromMetadata(platform, sourceUrl, metadata);
  return channelUrl ? resolveChannelIdentity(channelUrl) : null;
}

// Recover a channel identity by going back to the item's own source. Used by the
// backfill for items whose metadata was never persisted: the YouTube watch page
// exposes the channel id directly (no container needed), while Bilibili's risk
// control forces us through the container's WARP egress.
export async function resolveItemChannelIdentityFromSource(
  env: Env,
  platform: string,
  sourceUrl: string,
): Promise<ChannelIdentity | null> {
  if (!parseUrl(sourceUrl)) return null;
  if (platform === "youtube") {
    const scraped = await fetchYoutubeVideoChannelId(sourceUrl);
    if (scraped) return resolveItemChannelIdentity(platform, sourceUrl, { channel_id: scraped });
  }
  if (platform === "youtube" || platform === "bilibili") {
    const { fetchMetadata } = await import("../pipeline/container");
    const metadata = await fetchMetadata(env, sourceUrl, platform);
    return resolveItemChannelIdentity(platform, sourceUrl, metadata);
  }
  return resolveItemChannelIdentity(platform, sourceUrl, null);
}

// Create/refresh the channel and write BOTH relationship rows (channel_item is
// authoritative for the UI, item_feed still drives subscriber demand).
export async function attachChannelIdentity(
  env: Env,
  item: ItemChannelTarget,
  identity: ChannelIdentity,
  metadata: ChannelHint | null | undefined,
): Promise<number> {
  const channel = await upsertChannel(env, identity, {
    title: metadata?.author,
    imageUrl: metadata?.thumbnail,
  });
  await linkChannelItem(env, channel.id, item.id);
  await linkItemFeed(env, item.id, identity.feedUrl);
  return channel.id;
}

export async function attachItemChannel(
  env: Env,
  item: ItemChannelTarget,
  metadata: ChannelHint | null | undefined,
): Promise<number | null> {
  const identity = await resolveItemChannelIdentity(item.platform, item.source_url, metadata);
  return identity ? attachChannelIdentity(env, item, identity, metadata) : null;
}

// Channel attribution must never fail an ingest or a finished pipeline run: the
// item itself is still valid, the pipeline retries attribution when it completes,
// and the admin audit reports whatever is still missing.
export async function attachItemChannelBestEffort(
  env: Env,
  item: ItemChannelTarget,
  metadata: ChannelHint | null | undefined,
): Promise<number | null> {
  try {
    return await attachItemChannel(env, item, metadata);
  } catch (err) {
    console.warn("channel attribution failed", { item_id: item.id, err: String(err) });
    return null;
  }
}
