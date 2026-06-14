import type { Env } from "../env";
import { first, upsertItem, type ItemRow } from "../db";
import { detectPlatform, normalizeUrl } from "./url";
import { priorityScore } from "./priority";

export interface ItemMetadata {
  title?: string | null;
  author?: string | null;
  description?: string | null;
  duration_s?: number | null;
  published_at?: string | null;
  thumbnail?: string | null;
  external_id?: string | null;
  view_count?: number | null;
  like_count?: number | null;
  dislike_count?: number | null;
  // Channel id (YouTube). Used to derive the channel feed for the subscriber
  // -demand signal; not persisted on the item row itself.
  channel_id?: string | null;
}

// Derive the canonical YouTube channel feed URL from a channel id. This matches
// the feed_url shape stored for YouTube subscriptions (see routes/subscriptions),
// so a manually-added video links to the same feed its subscribers follow.
export function youtubeChannelFeed(channelId?: string | null): string | null {
  return channelId ? `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` : null;
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

export async function persistItemMetadata(
  env: Env,
  itemId: number,
  m: ItemMetadata,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE item SET
       title = COALESCE(?, title), author = COALESCE(?, author),
       description = COALESCE(?, description), duration_s = COALESCE(?, duration_s),
       published_at = COALESCE(?, published_at), thumbnail = COALESCE(?, thumbnail),
       external_id = COALESCE(?, external_id), view_count = COALESCE(?, view_count),
       like_count = COALESCE(?, like_count), dislike_count = COALESCE(?, dislike_count)
     WHERE id = ?`,
  )
    .bind(
      m.title ?? null,
      m.author ?? null,
      m.description ?? null,
      m.duration_s ?? null,
      m.published_at ?? null,
      m.thumbnail ?? null,
      m.external_id ?? null,
      m.view_count ?? null,
      m.like_count ?? null,
      m.dislike_count ?? null,
      itemId,
    )
    .run();
}

// Recompute an item's demand counters + priority score from current state:
//   request_count    = # of users who have it in their library
//   subscriber_demand = # of subscriptions (across all users) to any feed that
//                       produced this item for someone
export async function recomputePriority(env: Env, itemId: number): Promise<void> {
  const reqRow = await first<{ n: number }>(
    env.DB.prepare("SELECT COUNT(*) AS n FROM user_item WHERE item_id = ?").bind(itemId),
  );
  const request_count = reqRow?.n ?? 0;
  const interestRow = await first<{ n: number }>(
    env.DB.prepare("SELECT COUNT(*) AS n FROM item_interest WHERE item_id = ?").bind(itemId),
  );
  const interest_count = interestRow?.n ?? 0;

  // Subscribed people: distinct users subscribed to any feed/channel this item
  // belongs to (via the global item_feed association, independent of who has it
  // saved). This credits popular channels even for manually-added videos.
  const subRow = await first<{ n: number }>(
    env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) AS n FROM subscription
        WHERE feed_url IN (SELECT feed_url FROM item_feed WHERE item_id = ?)`,
    ).bind(itemId),
  );
  const subscriber_demand = subRow?.n ?? 0;

  const item = await first<ItemRow>(
    env.DB.prepare("SELECT view_count FROM item WHERE id = ?").bind(itemId),
  );
  const score = priorityScore({
    view_count: item?.view_count ?? 0,
    subscriber_demand,
    request_count,
    interest_count,
  });

  await env.DB.prepare(
    "UPDATE item SET request_count = ?, interest_count = ?, subscriber_demand = ?, priority_score = ? WHERE id = ?",
  )
    .bind(request_count, interest_count, subscriber_demand, score, itemId)
    .run();
}

export interface AddResult {
  item: ItemRow;
  created: boolean;
  newlySaved: boolean;
}

// Core dedup primitive: ensure the global item exists, attach it to the user's
// library (waiting if still processing, done if already complete), bump demand,
// and enqueue processing only when the item isn't already done/in-flight.
export async function addUrlToLibrary(
  env: Env,
  userId: number,
  rawUrl: string,
  opts: {
    title?: string | null;
    external_id?: string | null;
    platform?: string;
    folderId?: number | null;
    subscriptionId?: number | null;
    // Feed/channel URL this item was ingested from (e.g. a subscription poll).
    feedUrl?: string | null;
    // Feed-provided metadata (e.g. podcast RSS): authoritative for items whose
    // audio URL can't be scraped for rich metadata. Applied last so it wins.
    meta?: ItemMetadata;
  } = {},
): Promise<AddResult | null> {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  const platform = opts.platform || detectPlatform(url);
  let metadata: ItemMetadata | null = null;
  try {
    const { fetchMetadata } = await import("../pipeline/container");
    metadata = await fetchMetadata(env, url, platform);
  } catch (err) {
    console.warn("metadata prefetch failed", { url, err: String(err) });
  }

  const { item, created } = await upsertItem(env, {
    source_url: url,
    platform,
    title: opts.title ?? opts.meta?.title ?? metadata?.title,
    external_id: opts.external_id ?? opts.meta?.external_id ?? metadata?.external_id,
  });

  if (metadata) {
    await persistItemMetadata(env, item.id, metadata);
  }
  // Feed metadata overrides the (often empty) scraped metadata for podcasts.
  if (opts.meta) {
    await persistItemMetadata(env, item.id, opts.meta);
  }

  // Link this item to its channel feed (derived from metadata) and the feed it
  // was ingested from, so subscriber demand reflects the whole channel audience.
  if (platform === "youtube") {
    await linkItemFeed(env, item.id, youtubeChannelFeed(metadata?.channel_id));
  }
  await linkItemFeed(env, item.id, opts.feedUrl);

  const personalStatus = item.status === "done" ? "done" : "waiting";
  const existingUi = await first<{ id: number }>(
    env.DB.prepare("SELECT id FROM user_item WHERE user_id = ? AND item_id = ?").bind(
      userId,
      item.id,
    ),
  );
  const newlySaved = existingUi === null;
  await env.DB.prepare(
    `INSERT INTO user_item (user_id, item_id, folder_id, subscription_id, personal_status)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, item_id) DO UPDATE SET
       folder_id = COALESCE(excluded.folder_id, user_item.folder_id),
       subscription_id = COALESCE(excluded.subscription_id, user_item.subscription_id)`,
  )
    .bind(userId, item.id, opts.folderId ?? null, opts.subscriptionId ?? null, personalStatus)
    .run();

  await recomputePriority(env, item.id);

  // Enqueue only when the content still needs processing and isn't mid-flight.
  const fresh = await first<ItemRow>(
    env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(item.id),
  );
  if (fresh && (fresh.status === "queued" || fresh.status === "error")) {
    await env.PIPELINE.send({ kind: "process", item_id: item.id });
  }
  return { item: fresh ?? item, created, newlySaved };
}
