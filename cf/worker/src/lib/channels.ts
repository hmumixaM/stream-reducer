import type { ChannelFollowRow, ChannelRow } from "../db";
import { all, first } from "../db";
import type { Env } from "../env";
import { parseBilibiliUrl } from "./bilibili";
import { resolveFeedUrl } from "./feed";
import { detectPlatform, type Platform } from "./url";

export type ChannelKeyKind = "provider_id" | "feed_url";

export interface ChannelIdentity {
  platform: Platform;
  channelKey: string;
  keyKind: ChannelKeyKind;
  feedUrl: string;
  sourceUrl: string;
}

export interface ChannelMetadata {
  title?: string | null;
  imageUrl?: string | null;
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "feature",
  "si",
  "spm_id_from",
  "vd_source",
  "from_source",
  "share_source",
  "share_medium",
]);

export function isHostOrSubdomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const root = domain.toLowerCase();
  return host === root || host.endsWith(`.${root}`);
}

export function normalizeChannelUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("channel URL must use http or https");
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      url.searchParams.delete(key);
    }
  }
  const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
    ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk),
  );
  url.search = "";
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

// Pure identity derivation, split from resolveChannelIdentity so URL behavior
// can be tested without network calls for YouTube handles and Apple pages.
export function deriveChannelIdentity(rawUrl: string, resolvedFeedUrl: string): ChannelIdentity {
  const sourceUrl = normalizeChannelUrl(rawUrl);
  const feedUrl = normalizeChannelUrl(resolvedFeedUrl);
  const sourcePlatform = detectPlatform(sourceUrl);

  const feed = new URL(feedUrl);
  if (isHostOrSubdomain(feed.hostname, "youtube.com") && feed.pathname === "/feeds/videos.xml") {
    const channelId = feed.searchParams.get("channel_id");
    if (channelId && /^UC[0-9A-Za-z_-]{22}$/.test(channelId)) {
      return {
        platform: "youtube",
        channelKey: channelId,
        keyKind: "provider_id",
        feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
        sourceUrl,
      };
    }
  }
  if (sourcePlatform === "youtube") {
    throw new Error("Could not resolve this YouTube URL to a channel feed");
  }

  const bili = parseBilibiliUrl(feedUrl) ?? parseBilibiliUrl(sourceUrl);
  if (bili) {
    return {
      platform: "bilibili",
      channelKey: bili.mid,
      keyKind: "provider_id",
      // Lists are discovery URLs for their owner channel, not independent
      // follows. Poll the stable owner space so another list cannot retarget the
      // shared channel's canonical feed.
      feedUrl: `https://space.bilibili.com/${bili.mid}`,
      sourceUrl,
    };
  }
  if (sourcePlatform === "bilibili") {
    throw new Error("Could not resolve this Bilibili URL to a channel owner");
  }

  return {
    // Feed-key identities use one namespace regardless of whether discovery
    // started from an Apple/Xiaoyuzhou page or from the raw RSS URL.
    platform: "rss",
    channelKey: feedUrl,
    keyKind: "feed_url",
    feedUrl,
    sourceUrl,
  };
}

export async function resolveChannelIdentity(rawUrl: string): Promise<ChannelIdentity> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("channel URL is required");
  // Validate before resolving so malformed text never becomes an RSS key.
  normalizeChannelUrl(trimmed);
  const resolved = await resolveFeedUrl(trimmed);
  const source = new URL(normalizeChannelUrl(trimmed));
  const feed = new URL(normalizeChannelUrl(resolved));
  if (
    (isHostOrSubdomain(source.hostname, "podcasts.apple.com") ||
      isHostOrSubdomain(source.hostname, "itunes.apple.com")) &&
    (isHostOrSubdomain(feed.hostname, "podcasts.apple.com") ||
      isHostOrSubdomain(feed.hostname, "itunes.apple.com"))
  ) {
    throw new Error("Could not resolve this Apple Podcasts page to its RSS feed");
  }
  return deriveChannelIdentity(trimmed, resolved);
}

export async function upsertChannel(
  env: Env,
  identity: ChannelIdentity,
  metadata: ChannelMetadata = {},
): Promise<ChannelRow> {
  const title = metadata.title?.trim() || null;
  const imageUrl = metadata.imageUrl?.trim() || null;
  await env.DB.prepare(
    `INSERT INTO channel
       (platform, channel_key, key_kind, feed_url, source_url, title, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, channel_key) DO UPDATE SET
       key_kind = excluded.key_kind,
       feed_url = excluded.feed_url,
       source_url = COALESCE(channel.source_url, excluded.source_url),
       title = COALESCE(excluded.title, channel.title),
       image_url = COALESCE(excluded.image_url, channel.image_url),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(
      identity.platform,
      identity.channelKey,
      identity.keyKind,
      identity.feedUrl,
      identity.sourceUrl,
      title,
      imageUrl,
    )
    .run();
  const row = await first<ChannelRow>(
    env.DB.prepare("SELECT * FROM channel WHERE platform = ? AND channel_key = ?").bind(
      identity.platform,
      identity.channelKey,
    ),
  );
  if (!row) throw new Error("failed to upsert channel");
  return row;
}

export async function linkChannelItem(env: Env, channelId: number, itemId: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO channel_item (channel_id, item_id) VALUES (?, ?)",
  ).bind(channelId, itemId).run();
}

export async function findUserFollow(
  env: Env,
  userId: number,
  channelId: number,
): Promise<ChannelFollowRow | null> {
  return first<ChannelFollowRow>(
    env.DB.prepare("SELECT * FROM subscription WHERE user_id = ? AND channel_id = ?").bind(
      userId,
      channelId,
    ),
  );
}

export async function findUnmigratedUserFollowsByIdentity(
  env: Env,
  userId: number,
  identity: { platform: string; channelKey: string },
): Promise<ChannelFollowRow[]> {
  const candidates = await all<ChannelFollowRow>(
    env.DB.prepare(
      "SELECT * FROM subscription WHERE user_id = ? AND channel_id IS NULL ORDER BY id",
    ).bind(userId),
  );
  const matching: ChannelFollowRow[] = [];
  for (const candidate of candidates) {
    try {
      const resolved = await resolveChannelIdentity(candidate.feed_url);
      if (
        resolved.platform === identity.platform &&
        resolved.channelKey === identity.channelKey
      ) {
        matching.push(candidate);
      }
    } catch {
      // Leave unresolved legacy rows untouched for the admin migration report.
    }
  }
  return matching;
}

export interface FollowMergeOverrides {
  enabled?: number;
  folderId?: number | null;
  windowDays?: number;
  minPublishedAt?: string | null;
  intervalMinutes?: number;
}

export interface ResolvedChannelFollow {
  follow: ChannelFollowRow;
  identity: ChannelIdentity;
}

export function groupSelectedResolvedFollows(
  selectedIds: ReadonlySet<number>,
  resolved: ResolvedChannelFollow[],
): Map<string, ResolvedChannelFollow[]> {
  const keyFor = (entry: ResolvedChannelFollow) =>
    `${entry.follow.user_id}\u0000${entry.identity.platform}\u0000${entry.identity.channelKey}`;
  const selectedGroupKeys = new Set(
    resolved.filter((entry) => selectedIds.has(entry.follow.id)).map(keyFor),
  );
  const groups = new Map<string, ResolvedChannelFollow[]>();
  for (const entry of resolved) {
    const key = keyFor(entry);
    if (!selectedGroupKeys.has(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

export async function mergeFollowsIntoChannel(
  env: Env,
  channel: ChannelRow,
  rows: ChannelFollowRow[],
  overrides: FollowMergeOverrides = {},
): Promise<ChannelFollowRow> {
  if (!rows.length) throw new Error("cannot attach an empty follow group");
  const merged = mergeFollowState(rows);
  const survivor = rows.find((row) => row.id === merged.survivorId)!;
  const duplicateIds = merged.duplicateIds;
  const statements: D1PreparedStatement[] = [];
  if (duplicateIds.length) {
    const placeholders = duplicateIds.map(() => "?").join(",");
    statements.push(
      env.DB.prepare(
        `UPDATE user_item SET subscription_id = ?
          WHERE subscription_id IN (${placeholders})`,
      ).bind(merged.survivorId, ...duplicateIds),
      env.DB.prepare(
        `UPDATE subscription_comment SET subscription_id = ?
          WHERE subscription_id IN (${placeholders})`,
      ).bind(merged.survivorId, ...duplicateIds),
      env.DB.prepare(
        `UPDATE subscription_highlight SET subscription_id = ?
          WHERE subscription_id IN (${placeholders})`,
      ).bind(merged.survivorId, ...duplicateIds),
      env.DB.prepare(
        `DELETE FROM subscription WHERE id IN (${placeholders})`,
      ).bind(...duplicateIds),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE subscription
          SET channel_id = ?, enabled = ?, window_days = ?,
              min_published_at = ?, folder_id = ?, interval_minutes = ?,
              last_checked_at = ?, last_seen_guid = ?, last_status = ?,
              last_error = ?, last_entry_count = ?, last_new_count = ?,
              consecutive_failures = ?
        WHERE id = ?`,
    ).bind(
      channel.id,
      overrides.enabled ?? merged.enabled,
      overrides.windowDays ?? merged.windowDays,
      overrides.minPublishedAt !== undefined
        ? overrides.minPublishedAt
        : merged.minPublishedAt,
      overrides.folderId !== undefined ? overrides.folderId : merged.folderId,
      overrides.intervalMinutes ?? survivor.interval_minutes,
      merged.health.last_checked_at,
      merged.health.last_seen_guid,
      merged.health.last_status,
      merged.health.last_error,
      merged.health.last_entry_count,
      merged.health.last_new_count,
      merged.health.consecutive_failures,
      merged.survivorId,
    ),
  );
  for (const feedUrl of [...new Set(rows.map((row) => row.feed_url))]) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO channel_item (channel_id, item_id)
         SELECT ?, item_id FROM item_feed WHERE feed_url = ?`,
      ).bind(channel.id, feedUrl),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE channel
          SET title = COALESCE(
                title,
                (SELECT i.author
                   FROM channel_item ci
                   JOIN item i ON i.id = ci.item_id
                  WHERE ci.channel_id = channel.id
                    AND i.author IS NOT NULL
                    AND TRIM(i.author) != ''
                    AND i.status != 'excluded'
                  ORDER BY i.published_at DESC, i.id DESC
                  LIMIT 1)
              ),
              image_url = COALESCE(
                image_url,
                (SELECT i.thumbnail
                   FROM channel_item ci
                   JOIN item i ON i.id = ci.item_id
                  WHERE ci.channel_id = channel.id
                    AND i.thumbnail IS NOT NULL
                    AND TRIM(i.thumbnail) != ''
                    AND i.status != 'excluded'
                  ORDER BY i.published_at DESC, i.id DESC
                  LIMIT 1)
              ),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).bind(channel.id),
  );
  await env.DB.batch(statements);
  const attached = await first<ChannelFollowRow>(
    env.DB.prepare("SELECT * FROM subscription WHERE id = ?").bind(merged.survivorId),
  );
  if (!attached) throw new Error("failed to attach channel follow");
  return attached;
}

export interface ChannelItemBrief {
  id: number;
  title: string | null;
  headline: string | null;
  thumbnail: string | null;
  published_at: string | null;
  status: string;
}

export interface ChannelFollowRead {
  id: number;
  channel_id: number | null;
  title: string | null;
  platform: string;
  feed_url: string;
  follow_latest: boolean;
  folder_id: number | null;
  interval_minutes: number;
  window_days: number;
  min_published_at: string | null;
  last_checked_at: string | null;
  last_seen_guid: string | null;
  last_status: string | null;
  last_error: string | null;
  last_entry_count: number;
  last_new_count: number;
  consecutive_failures: number;
  created_at: string;
}

export function toChannelFollowRead(
  follow: ChannelFollowRow,
  channel?: ChannelRow | null,
): ChannelFollowRead {
  return {
    id: follow.id,
    channel_id: follow.channel_id,
    title: follow.title ?? channel?.title ?? null,
    platform: channel?.platform ?? follow.platform,
    feed_url: channel?.feed_url ?? follow.feed_url,
    follow_latest: Boolean(follow.enabled),
    folder_id: follow.folder_id,
    interval_minutes: follow.interval_minutes,
    window_days: follow.window_days,
    min_published_at: follow.min_published_at,
    last_checked_at: follow.last_checked_at,
    last_seen_guid: follow.last_seen_guid,
    last_status: follow.last_status,
    last_error: follow.last_error,
    last_entry_count: follow.last_entry_count,
    last_new_count: follow.last_new_count,
    consecutive_failures: follow.consecutive_failures,
    created_at: follow.created_at,
  };
}

export interface ChannelCatalogRow extends ChannelRow {
  follower_count: number;
  item_count: number;
  latest_published_at: string | null;
  follow_id: number | null;
  follow_user_id: number | null;
  follow_channel_id: number | null;
  follow_platform: string | null;
  follow_feed_url: string | null;
  follow_title: string | null;
  follow_interval_minutes: number | null;
  follow_window_days: number | null;
  follow_min_published_at: string | null;
  follow_enabled: number | null;
  follow_last_checked_at: string | null;
  follow_last_seen_guid: string | null;
  follow_last_status: string | null;
  follow_last_error: string | null;
  follow_last_entry_count: number | null;
  follow_last_new_count: number | null;
  follow_consecutive_failures: number | null;
  follow_folder_id: number | null;
  follow_created_at: string | null;
}

function followFromCatalogRow(row: ChannelCatalogRow): ChannelFollowRow | null {
  if (row.follow_id == null) return null;
  return {
    id: row.follow_id,
    user_id: row.follow_user_id!,
    channel_id: row.follow_channel_id,
    platform: row.follow_platform!,
    feed_url: row.follow_feed_url!,
    title: row.follow_title,
    interval_minutes: row.follow_interval_minutes!,
    window_days: row.follow_window_days!,
    min_published_at: row.follow_min_published_at,
    enabled: row.follow_enabled!,
    last_checked_at: row.follow_last_checked_at,
    last_seen_guid: row.follow_last_seen_guid,
    last_status: row.follow_last_status,
    last_error: row.follow_last_error,
    last_entry_count: row.follow_last_entry_count!,
    last_new_count: row.follow_last_new_count!,
    consecutive_failures: row.follow_consecutive_failures!,
    folder_id: row.follow_folder_id,
    created_at: row.follow_created_at!,
  };
}

export function toChannelRead(
  row: ChannelCatalogRow,
  latestItems: ChannelItemBrief[] = [],
) {
  const follow = followFromCatalogRow(row);
  return {
    id: row.id,
    platform: row.platform,
    channel_key: row.channel_key,
    feed_url: row.feed_url,
    source_url: row.source_url,
    title: follow?.title ?? row.title,
    image_url: row.image_url ?? latestItems.find((item) => item.thumbnail)?.thumbnail ?? null,
    follower_count: row.follower_count,
    item_count: row.item_count,
    latest_published_at: row.latest_published_at,
    latest_items: latestItems,
    follow: follow ? toChannelFollowRead(follow, row) : null,
  };
}

export interface MergedFollowState {
  survivorId: number;
  duplicateIds: number[];
  enabled: number;
  windowDays: number;
  minPublishedAt: string | null;
  folderId: number | null;
  folderConflict: boolean;
  health: Pick<
    ChannelFollowRow,
    | "last_checked_at"
    | "last_seen_guid"
    | "last_status"
    | "last_error"
    | "last_entry_count"
    | "last_new_count"
    | "consecutive_failures"
  >;
}

export function mergeFollowState(rows: ChannelFollowRow[]): MergedFollowState {
  if (!rows.length) throw new Error("cannot merge an empty follow group");
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const survivor = ordered[0];
  const health = [...ordered].sort((a, b) =>
    (b.last_checked_at ?? "").localeCompare(a.last_checked_at ?? ""),
  )[0];
  const folders = [...new Set(ordered.flatMap((row) => row.folder_id == null ? [] : [row.folder_id]))];
  return {
    survivorId: survivor.id,
    duplicateIds: ordered.slice(1).map((row) => row.id),
    enabled: Math.max(...ordered.map((row) => row.enabled)),
    windowDays: Math.max(...ordered.map((row) => row.window_days)),
    minPublishedAt:
      ordered
        .map((row) => row.min_published_at)
        .filter((value): value is string => value !== null)
        .sort()[0] ?? null,
    folderId: survivor.folder_id ?? folders[0] ?? null,
    folderConflict: folders.length > 1,
    health: {
      last_checked_at: health.last_checked_at,
      last_seen_guid: health.last_seen_guid,
      last_status: health.last_status,
      last_error: health.last_error,
      last_entry_count: health.last_entry_count,
      last_new_count: health.last_new_count,
      consecutive_failures: health.consecutive_failures,
    },
  };
}
