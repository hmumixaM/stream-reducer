import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import {
  all,
  first,
  type ChannelRow,
  type ItemRow,
} from "../db";
import {
  findUserFollow,
  findUnmigratedUserFollowsByIdentity,
  mergeFollowsIntoChannel,
  mergeFollowState,
  resolveChannelIdentity,
  toChannelFollowRead,
  toChannelRead,
  upsertChannel,
  type ChannelCatalogRow,
  type ChannelItemBrief,
} from "../lib/channels";
import { recomputePriority } from "../lib/ingest";
import { readJson } from "../lib/request";
import { toItemRead } from "../lib/serialize";
import { isoNow } from "../lib/crypto";

export const channelRoutes = new Hono<AppContext>();
channelRoutes.use("*", requireAuth);

const CHANNEL_SELECT = `
  SELECT ch.*,
         (SELECT COUNT(*) FROM subscription sf WHERE sf.channel_id = ch.id) AS follower_count,
         (SELECT COUNT(*)
            FROM channel_item ci JOIN item count_item ON count_item.id = ci.item_id
           WHERE ci.channel_id = ch.id AND count_item.status != 'excluded') AS item_count,
         (SELECT MAX(i.published_at)
            FROM channel_item ci JOIN item i ON i.id = ci.item_id
           WHERE ci.channel_id = ch.id AND i.status != 'excluded') AS latest_published_at,
         f.id AS follow_id, f.user_id AS follow_user_id,
         f.channel_id AS follow_channel_id, f.platform AS follow_platform,
         f.feed_url AS follow_feed_url, f.title AS follow_title,
         f.interval_minutes AS follow_interval_minutes,
         f.window_days AS follow_window_days,
         f.min_published_at AS follow_min_published_at,
         f.enabled AS follow_enabled,
         f.last_checked_at AS follow_last_checked_at,
         f.last_seen_guid AS follow_last_seen_guid,
         f.last_status AS follow_last_status,
         f.last_error AS follow_last_error,
         f.last_entry_count AS follow_last_entry_count,
         f.last_new_count AS follow_last_new_count,
         f.consecutive_failures AS follow_consecutive_failures,
         f.folder_id AS follow_folder_id,
         f.created_at AS follow_created_at
    FROM channel ch
    LEFT JOIN subscription f ON f.channel_id = ch.id AND f.user_id = ?`;

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function minPublishedAt(windowDays: number): string {
  return new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
}

async function enqueueFollowPoll(
  env: AppContext["Bindings"],
  followId: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE subscription SET last_checked_at = ? WHERE id = ?",
  ).bind(isoNow(), followId).run();
  await env.PIPELINE.send({ kind: "poll", subscription_id: followId });
}

async function folderBelongsToUser(
  env: AppContext["Bindings"],
  folderId: number,
  userId: number,
): Promise<boolean> {
  return (await first<{ id: number }>(
    env.DB.prepare("SELECT id FROM itemgroup WHERE id = ? AND user_id = ?").bind(
      folderId,
      userId,
    ),
  )) !== null;
}

async function latestItemsByChannel(
  env: AppContext["Bindings"],
  channelIds: number[],
): Promise<Map<number, ChannelItemBrief[]>> {
  const result = new Map<number, ChannelItemBrief[]>();
  if (!channelIds.length) return result;
  const placeholders = channelIds.map(() => "?").join(",");
  const rows = await all<ChannelItemBrief & { channel_id: number }>(
    env.DB.prepare(
      `SELECT channel_id, id, title, headline, thumbnail, published_at, status
         FROM (
           SELECT ci.channel_id, i.id, i.title, i.headline, i.thumbnail,
                  i.published_at, i.status,
                  ROW_NUMBER() OVER (
                    PARTITION BY ci.channel_id
                    ORDER BY i.published_at DESC, i.id DESC
                  ) AS position
             FROM channel_item ci
             JOIN item i ON i.id = ci.item_id
            WHERE ci.channel_id IN (${placeholders})
              AND i.status != 'excluded'
         )
        WHERE position <= 3
        ORDER BY channel_id, published_at DESC, id DESC`,
    ).bind(...channelIds),
  );
  for (const row of rows) {
    const items = result.get(row.channel_id) ?? [];
    items.push({
      id: row.id,
      title: row.title,
      headline: row.headline,
      thumbnail: row.thumbnail,
      published_at: row.published_at,
      status: row.status,
    });
    result.set(row.channel_id, items);
  }
  return result;
}

async function getChannel(
  env: AppContext["Bindings"],
  userId: number,
  channelId: number,
): Promise<ChannelCatalogRow | null> {
  return first<ChannelCatalogRow>(
    env.DB.prepare(`${CHANNEL_SELECT} WHERE ch.id = ?`).bind(userId, channelId),
  );
}

async function recomputeChannelPriorities(
  env: AppContext["Bindings"],
  channel: ChannelRow,
): Promise<void> {
  const rows = await all<{ item_id: number }>(
    env.DB.prepare(
      `SELECT item_id FROM channel_item WHERE channel_id = ?
       UNION
       SELECT item_id FROM item_feed WHERE feed_url = ?`,
    ).bind(channel.id, channel.feed_url),
  );
  for (const row of rows) await recomputePriority(env, row.item_id);
}

interface FollowBody {
  follow_latest?: boolean;
  folder_id?: number | null;
  window_days?: number;
  interval_minutes?: number;
}

function validateFollowBody(
  body: FollowBody,
  requireFollowLatest: boolean,
): string | null {
  if (requireFollowLatest && typeof body.follow_latest !== "boolean") {
    return "follow_latest must be a boolean";
  }
  if ("follow_latest" in body && typeof body.follow_latest !== "boolean") {
    return "follow_latest must be a boolean";
  }
  if (
    body.folder_id !== undefined &&
    body.folder_id !== null &&
    (!Number.isInteger(body.folder_id) || body.folder_id <= 0)
  ) {
    return "folder_id must be a positive integer or null";
  }
  if (
    body.window_days !== undefined &&
    (!Number.isInteger(body.window_days) || body.window_days < 1 || body.window_days > 3650)
  ) {
    return "window_days must be between 1 and 3650";
  }
  if (
    body.interval_minutes !== undefined &&
    (!Number.isInteger(body.interval_minutes) ||
      body.interval_minutes < 15 ||
      body.interval_minutes > 10080)
  ) {
    return "interval_minutes must be between 15 and 10080";
  }
  return null;
}

channelRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  const query = (c.req.query("q") ?? "").trim().slice(0, 100);
  const platform = (c.req.query("platform") ?? "").trim();
  const following = c.req.query("following");
  if (following !== undefined && following !== "true" && following !== "false") {
    return c.json({ error: "following must be true or false" }, 400);
  }
  const limit = boundedInt(c.req.query("limit"), 24, 1, 50);
  const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
  const where: string[] = [];
  const binds: unknown[] = [userId];
  if (query) {
    where.push("COALESCE(f.title, ch.title, ch.feed_url) LIKE ?");
    binds.push(`%${query}%`);
  }
  if (platform) {
    where.push("ch.platform = ?");
    binds.push(platform);
  }
  if (following === "true") where.push("f.id IS NOT NULL");
  if (following === "false") where.push("f.id IS NULL");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<ChannelCatalogRow>(
    c.env.DB.prepare(
      `${CHANNEL_SELECT}
       ${whereSql}
       ORDER BY (f.id IS NOT NULL) DESC,
                latest_published_at DESC,
                follower_count DESC,
                ch.id DESC
       LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset),
  );
  const latest = await latestItemsByChannel(c.env, rows.map((row) => row.id));
  return c.json(rows.map((row) => toChannelRead(row, latest.get(row.id) ?? [])));
});

channelRoutes.post("/resolve", async (c) => {
  const userId = c.get("user").id;
  const body = await readJson<{ url?: string }>(c);
  try {
    const channel = await upsertChannel(
      c.env,
      await resolveChannelIdentity(body.url ?? ""),
    );
    const row = await getChannel(c.env, userId, channel.id);
    if (!row) throw new Error("failed to read resolved channel");
    const latest = await latestItemsByChannel(c.env, [channel.id]);
    return c.json(toChannelRead(row, latest.get(channel.id) ?? []));
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "could not resolve channel" },
      400,
    );
  }
});

channelRoutes.get("/:id", async (c) => {
  const userId = c.get("user").id;
  const channelId = Number(c.req.param("id"));
  const row = await getChannel(c.env, userId, channelId);
  if (!row) return c.json({ error: "channel not found" }, 404);
  const latest = await latestItemsByChannel(c.env, [channelId]);
  return c.json(toChannelRead(row, latest.get(channelId) ?? []));
});

channelRoutes.put("/:id/follow", async (c) => {
  const userId = c.get("user").id;
  const channelId = Number(c.req.param("id"));
  const body = await readJson<FollowBody>(c);
  const error = validateFollowBody(body, true);
  if (error) return c.json({ error }, 400);
  const channel = await first<ChannelRow>(
    c.env.DB.prepare("SELECT * FROM channel WHERE id = ?").bind(channelId),
  );
  if (!channel) return c.json({ error: "channel not found" }, 404);
  const requestedFolderId = body.folder_id ?? null;
  if (
    body.folder_id !== undefined &&
    requestedFolderId !== null &&
    !(await folderBelongsToUser(c.env, requestedFolderId, userId))
  ) {
    return c.json({ error: "folder not found" }, 400);
  }

  const linked = await findUserFollow(c.env, userId, channelId);
  const aliases = await findUnmigratedUserFollowsByIdentity(c.env, userId, {
    platform: channel.platform,
    channelKey: channel.channel_key,
  });
  const candidates = [
    ...(linked ? [linked] : []),
    ...aliases.filter((alias) => alias.id !== linked?.id),
  ];
  const merged = candidates.length ? mergeFollowState(candidates) : null;
  const survivor = merged
    ? candidates.find((candidate) => candidate.id === merged.survivorId)!
    : null;
  const wasEnabled = candidates.some((candidate) => Boolean(candidate.enabled));
  const folderId =
    body.folder_id !== undefined ? requestedFolderId : merged?.folderId ?? null;
  const windowDays =
    body.window_days ??
    merged?.windowDays ??
    Number(c.env.SUBSCRIPTION_WINDOW_DAYS || "90");
  const intervalMinutes = body.interval_minutes ?? survivor?.interval_minutes ?? 60;
  const cutoff =
    body.window_days !== undefined || !merged
      ? minPublishedAt(windowDays)
      : merged.minPublishedAt;
  const enabled = body.follow_latest ? 1 : 0;
  if (candidates.length) {
    await mergeFollowsIntoChannel(c.env, channel, candidates, {
      enabled,
      folderId,
      windowDays,
      minPublishedAt: cutoff,
      intervalMinutes,
    });
  } else {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO subscription
         (user_id, channel_id, platform, feed_url, interval_minutes, window_days,
          min_published_at, folder_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      channel.id,
      channel.platform,
      channel.feed_url,
      intervalMinutes,
      windowDays,
      cutoff,
      folderId,
      enabled,
    ).run();
  }
  let updated = await findUserFollow(c.env, userId, channelId);
  if (!updated) throw new Error("failed to read channel follow");
  await recomputeChannelPriorities(c.env, channel);
  if (!wasEnabled && updated.enabled) {
    await enqueueFollowPoll(c.env, updated.id);
    updated = await findUserFollow(c.env, userId, channelId);
    if (!updated) throw new Error("failed to refresh channel follow");
  }
  return c.json(toChannelFollowRead(updated, channel));
});

channelRoutes.patch("/:id/follow", async (c) => {
  const userId = c.get("user").id;
  const channelId = Number(c.req.param("id"));
  const body = await readJson<FollowBody>(c);
  const error = validateFollowBody(body, false);
  if (error) return c.json({ error }, 400);
  const channel = await first<ChannelRow>(
    c.env.DB.prepare("SELECT * FROM channel WHERE id = ?").bind(channelId),
  );
  if (!channel) return c.json({ error: "channel not found" }, 404);
  const follow = await findUserFollow(c.env, userId, channelId);
  if (!follow) return c.json({ error: "channel follow not found" }, 404);
  if (
    body.folder_id != null &&
    !(await folderBelongsToUser(c.env, body.folder_id, userId))
  ) {
    return c.json({ error: "folder not found" }, 400);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.follow_latest !== undefined) {
    sets.push("enabled = ?");
    binds.push(body.follow_latest ? 1 : 0);
  }
  if ("folder_id" in body) {
    sets.push("folder_id = ?");
    binds.push(body.folder_id ?? null);
  }
  if (body.window_days !== undefined) {
    sets.push("window_days = ?", "min_published_at = ?");
    binds.push(body.window_days, minPublishedAt(body.window_days));
  }
  if (body.interval_minutes !== undefined) {
    sets.push("interval_minutes = ?");
    binds.push(body.interval_minutes);
  }
  if (sets.length) {
    await c.env.DB.prepare(
      `UPDATE subscription SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
    ).bind(...binds, follow.id, userId).run();
  }
  let updated = await findUserFollow(c.env, userId, channelId);
  if (!updated) throw new Error("failed to read channel follow");
  if (!follow.enabled && updated.enabled) {
    await enqueueFollowPoll(c.env, updated.id);
    updated = await findUserFollow(c.env, userId, channelId);
    if (!updated) throw new Error("failed to refresh channel follow");
  }
  return c.json(toChannelFollowRead(updated, channel));
});

channelRoutes.delete("/:id/follow", async (c) => {
  const userId = c.get("user").id;
  const channelId = Number(c.req.param("id"));
  const channel = await first<ChannelRow>(
    c.env.DB.prepare("SELECT * FROM channel WHERE id = ?").bind(channelId),
  );
  if (!channel) return c.json({ error: "channel not found" }, 404);
  await c.env.DB.prepare(
    "DELETE FROM subscription WHERE user_id = ? AND channel_id = ?",
  ).bind(userId, channelId).run();
  await recomputeChannelPriorities(c.env, channel);
  return c.json({ ok: true });
});

channelRoutes.get("/:id/items", async (c) => {
  const userId = c.get("user").id;
  const channelId = Number(c.req.param("id"));
  const exists = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM channel WHERE id = ?").bind(channelId),
  );
  if (!exists) return c.json({ error: "channel not found" }, 404);
  const limit = boundedInt(c.req.query("limit"), 30, 1, 100);
  const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
  const rows = await all<
    ItemRow & {
      ui_id: number | null;
      folder_id: number | null;
      group_position: number | null;
      is_favorite: number | null;
      is_archived: number | null;
      personal_status: string | null;
      subscription_id: number | null;
    }
  >(
    c.env.DB.prepare(
      `SELECT i.*, ui.id AS ui_id, ui.folder_id, ui.group_position,
              ui.is_favorite, ui.is_archived, ui.personal_status,
              ui.subscription_id
         FROM channel_item ci
         JOIN item i ON i.id = ci.item_id
         LEFT JOIN user_item ui ON ui.item_id = i.id AND ui.user_id = ?
        WHERE ci.channel_id = ? AND i.status != 'excluded'
        ORDER BY i.published_at DESC, ci.discovered_at DESC, i.id DESC
        LIMIT ? OFFSET ?`,
    ).bind(userId, channelId, limit, offset),
  );
  return c.json(
    rows.map((row) => ({
      ...toItemRead(
        row,
        row.ui_id == null
          ? null
          : {
              folder_id: row.folder_id,
              group_position: row.group_position,
              is_favorite: row.is_favorite ?? 0,
              is_archived: row.is_archived ?? 0,
              personal_status: row.personal_status ?? "waiting",
              subscription_id: row.subscription_id,
            },
      ),
      in_library: row.ui_id !== null,
    })),
  );
});

channelRoutes.post("/:id/poll", async (c) => {
  const userId = c.get("user").id;
  const channelId = Number(c.req.param("id"));
  const follow = await findUserFollow(c.env, userId, channelId);
  if (!follow) return c.json({ error: "channel follow not found" }, 404);
  if (!follow.enabled) {
    return c.json({ error: "follow_latest must be enabled to poll" }, 400);
  }
  await enqueueFollowPoll(c.env, follow.id);
  return c.json({ ok: true });
});
