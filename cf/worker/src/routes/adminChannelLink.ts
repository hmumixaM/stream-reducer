import { Hono } from "hono";
import type { AppContext } from "../auth";
import { all, first, type ItemRow } from "../db";
import type { Env } from "../env";
import { recomputePriority } from "../lib/ingest";
import {
  attachChannelIdentity,
  channelUrlFromFeedRow,
  resolveItemChannelIdentityFromSource,
  type FeedRowResolution,
} from "../lib/itemChannel";
import { resolveChannelIdentity } from "../lib/channels";
import { errorMessage } from "../pipeline/transient";

// Admin tooling for item↔channel attribution: an audit that explains every item
// without a channel (and every channel without items), plus the backfill that
// repairs them. Mounted under /api/admin by routes/admin.
export const channelLinkRoutes = new Hono<AppContext>();

interface BucketRow {
  platform: string;
  bucket: string;
  n: number;
}

interface ZeroItemChannelRow {
  id: number;
  platform: string;
  title: string | null;
  feed_url: string;
  source_url: string | null;
  created_at: string;
  follower_count: number;
}

interface FollowHealthRow {
  channel_id: number;
  follow_id: number;
  enabled: number;
  last_checked_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_entry_count: number;
  last_new_count: number;
  consecutive_failures: number;
  min_published_at: string | null;
  window_days: number;
}

// Why an item has no channel. `instr` (not LIKE '%…%') because SQLite rejects
// wildcard LIKE patterns inside these nested EXISTS subqueries as "too complex".
const BUCKET_SQL = `
  CASE
    WHEN i.source_url NOT LIKE 'http%' THEN 'unresolvable_source_url'
    WHEN EXISTS (SELECT 1 FROM item_feed f
                  WHERE f.item_id = i.id AND instr(f.feed_url, 'channel_id=UC') > 0)
      THEN 'has_uc_feed_row'
    WHEN EXISTS (SELECT 1 FROM item_feed f
                  WHERE f.item_id = i.id AND instr(f.feed_url, 'channel_id=') > 0)
      THEN 'has_numeric_yt_template_row'
    WHEN EXISTS (SELECT 1 FROM item_feed f WHERE f.item_id = i.id)
      THEN 'has_other_feed_row'
    ELSE 'no_feed_row'
  END`;

const UNCHANNELED = `
  i.status != 'excluded'
  AND NOT EXISTS (SELECT 1 FROM channel_item ci WHERE ci.item_id = i.id)`;

channelLinkRoutes.get("/channel-link-audit", async (c) => {
  const totals = await first<{
    items_total: number;
    items_no_channel: number;
    channels_total: number;
    channel_links: number;
    channels_zero_items: number;
  }>(
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM item WHERE status != 'excluded') AS items_total,
         (SELECT COUNT(*) FROM item i WHERE ${UNCHANNELED}) AS items_no_channel,
         (SELECT COUNT(*) FROM channel) AS channels_total,
         (SELECT COUNT(*) FROM channel_item) AS channel_links,
         (SELECT COUNT(*) FROM channel ch
           WHERE NOT EXISTS (SELECT 1 FROM channel_item ci WHERE ci.channel_id = ch.id))
           AS channels_zero_items`,
    ),
  );

  const buckets = await all<BucketRow>(
    c.env.DB.prepare(
      `SELECT i.platform, ${BUCKET_SQL} AS bucket, COUNT(*) AS n
         FROM item i
        WHERE ${UNCHANNELED}
        GROUP BY i.platform, bucket
        ORDER BY n DESC`,
    ),
  );

  const zeroItemChannels = await all<ZeroItemChannelRow>(
    c.env.DB.prepare(
      `SELECT ch.id, ch.platform, ch.title, ch.feed_url, ch.source_url, ch.created_at,
              (SELECT COUNT(*) FROM subscription s WHERE s.channel_id = ch.id) AS follower_count
         FROM channel ch
        WHERE NOT EXISTS (SELECT 1 FROM channel_item ci WHERE ci.channel_id = ch.id)
        ORDER BY ch.id`,
    ),
  );

  // Poll health separates "polling is broken" from "nothing new inside the
  // window" for a channel that legitimately has no items yet.
  const follows = zeroItemChannels.length
    ? await all<FollowHealthRow>(
        c.env.DB.prepare(
          `SELECT channel_id, id AS follow_id, enabled, last_checked_at, last_status,
                  last_error, last_entry_count, last_new_count, consecutive_failures,
                  min_published_at, window_days
             FROM subscription
            WHERE channel_id IN (${zeroItemChannels.map(() => "?").join(",")})
            ORDER BY channel_id, id`,
        ).bind(...zeroItemChannels.map((row) => row.id)),
      )
    : [];

  return c.json({
    totals,
    items_no_channel_by_platform: buckets,
    channels_zero_items: zeroItemChannels.map((channel) => ({
      ...channel,
      follows: follows.filter((follow) => follow.channel_id === channel.id),
    })),
  });
});

type Phase = "a" | "b" | "auto";

interface BackfillOutcome {
  item_id: number;
  platform: string;
  phase: "a" | "b";
  channel_id: number | null;
  channel_key: string;
  repaired_feed_url: string | null;
}

interface BackfillSkip {
  item_id: number;
  platform: string;
  source_url: string;
  reason: string;
}

// Drop the malformed YouTube-template row the pipeline used to write for
// non-YouTube platforms. It can never match a real feed, and the attach step has
// already written the channel's real feed URL in its place.
async function dropDirtyFeedRow(env: Env, itemId: number, feedUrl: string): Promise<void> {
  await env.DB.prepare("DELETE FROM item_feed WHERE item_id = ? AND feed_url = ?")
    .bind(itemId, feedUrl)
    .run();
}

// Repair item↔channel attribution for items that predate (or were skipped by)
// the shared attach helper. Phase A is deterministic: it reads the channel
// identity back out of the item's existing item_feed rows (no network for
// YouTube/Bilibili rows). Phase B goes back to the item's own source_url, so it
// needs the network — and the container's WARP egress for Bilibili, whose risk
// control blocks the Worker — so run it in small batches.
channelLinkRoutes.post("/backfill-item-channels", async (c) => {
  const dryRun = c.req.query("dry_run") === "true";
  const phase = ((c.req.query("phase") ?? "auto") as Phase);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 200);
  const afterItemId = Math.max(Number(c.req.query("after_item_id")) || 0, 0);
  const platform = c.req.query("platform");

  const candidates = await all<Pick<ItemRow, "id" | "platform" | "source_url" | "author" | "thumbnail">>(
    c.env.DB.prepare(
      `SELECT i.id, i.platform, i.source_url, i.author, i.thumbnail
         FROM item i
        WHERE ${UNCHANNELED}
          AND i.id > ?
          AND (? IS NULL OR i.platform = ?)
        ORDER BY i.id
        LIMIT ?`,
    ).bind(afterItemId, platform ?? null, platform ?? null, limit),
  );

  const linked: BackfillOutcome[] = [];
  const skipped: BackfillSkip[] = [];
  let feedRowsRepaired = 0;

  for (const item of candidates) {
    const metadata = { author: item.author, thumbnail: item.thumbnail };
    const feedRows = await all<{ feed_url: string }>(
      c.env.DB.prepare("SELECT feed_url FROM item_feed WHERE item_id = ? ORDER BY feed_url").bind(
        item.id,
      ),
    );

    let resolution: FeedRowResolution | null = null;
    if (phase !== "b") {
      for (const row of feedRows) {
        resolution = channelUrlFromFeedRow(item.platform, row.feed_url);
        if (resolution) break;
      }
    }

    try {
      const identity = resolution
        ? await resolveChannelIdentity(resolution.channelUrl)
        : phase === "a"
          ? null
          : await resolveItemChannelIdentityFromSource(c.env, item.platform, item.source_url);
      if (!identity) {
        skipped.push({
          item_id: item.id,
          platform: item.platform,
          source_url: item.source_url,
          reason: resolution ? "identity not derivable" : "no channel identity in feed rows or source",
        });
        continue;
      }
      const outcome: BackfillOutcome = {
        item_id: item.id,
        platform: item.platform,
        phase: resolution ? "a" : "b",
        channel_id: null,
        channel_key: identity.channelKey,
        repaired_feed_url: resolution?.repairs ?? null,
      };
      if (!dryRun) {
        outcome.channel_id = await attachChannelIdentity(c.env, item, identity, metadata);
        if (resolution?.repairs) await dropDirtyFeedRow(c.env, item.id, resolution.repairs);
        await recomputePriority(c.env, item.id);
      }
      if (resolution?.repairs) feedRowsRepaired++;
      linked.push(outcome);
    } catch (err) {
      skipped.push({
        item_id: item.id,
        platform: item.platform,
        source_url: item.source_url,
        reason: errorMessage(err),
      });
    }
  }

  return c.json({
    dry_run: dryRun,
    phase,
    scanned: candidates.length,
    linked: linked.length,
    phase_a: linked.filter((row) => row.phase === "a").length,
    phase_b: linked.filter((row) => row.phase === "b").length,
    feed_rows_repaired: feedRowsRepaired,
    outcomes: linked,
    skipped,
    next_after_item_id: candidates.at(-1)?.id ?? afterItemId,
    exhausted: candidates.length < limit,
  });
});
