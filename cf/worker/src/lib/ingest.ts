import type { Env } from "../env";
import { first, upsertItem, type ItemRow } from "../db";
import { detectPlatform, normalizeUrl } from "./url";
import { priorityScore } from "./priority";

// Recompute an item's demand counters + priority score from current state:
//   request_count    = # of users who have it in their library
//   subscriber_demand = # of subscriptions (across all users) to any feed that
//                       produced this item for someone
export async function recomputePriority(env: Env, itemId: number): Promise<void> {
  const reqRow = await first<{ n: number }>(
    env.DB.prepare("SELECT COUNT(*) AS n FROM user_item WHERE item_id = ?").bind(itemId),
  );
  const request_count = reqRow?.n ?? 0;

  // Feeds that produced this item -> how many total subscriptions to those feeds.
  const subRow = await first<{ n: number }>(
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM subscription
        WHERE feed_url IN (
          SELECT s.feed_url FROM subscription s
          JOIN user_item ui ON ui.subscription_id = s.id
          WHERE ui.item_id = ?
        )`,
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
  });

  await env.DB.prepare(
    "UPDATE item SET request_count = ?, subscriber_demand = ?, priority_score = ? WHERE id = ?",
  )
    .bind(request_count, subscriber_demand, score, itemId)
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
  } = {},
): Promise<AddResult | null> {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  const platform = opts.platform || detectPlatform(url);
  const { item, created } = await upsertItem(env, {
    source_url: url,
    platform,
    title: opts.title,
    external_id: opts.external_id,
  });

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
