import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";
import { channelLinkRoutes } from "./adminChannelLink";

interface Executed {
  sql: string;
  bindings: unknown[];
}

// Fake D1 that answers by SQL fragment, and records only the statements that were
// actually executed — so a dry run can be asserted to write nothing.
function fakeEnv(answers: { match: string; rows?: unknown[]; first?: unknown }[]) {
  const executed: Executed[] = [];
  const answerFor = (sql: string) => answers.find((answer) => sql.includes(answer.match));
  const env = {
    DB: {
      prepare(sql: string) {
        const statement = {
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            statement.bindings = bindings;
            return statement;
          },
          async first() {
            executed.push({ sql, bindings: statement.bindings });
            return answerFor(sql)?.first ?? { n: 0 };
          },
          async all() {
            executed.push({ sql, bindings: statement.bindings });
            return { results: answerFor(sql)?.rows ?? [] };
          },
          async run() {
            executed.push({ sql, bindings: statement.bindings });
            return { success: true };
          },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, executed };
}

function app() {
  const instance = new Hono<AppContext>();
  instance.route("/admin", channelLinkRoutes);
  return instance;
}

const DIRTY_FEED = "https://www.youtube.com/feeds/videos.xml?channel_id=30201875";

// A Bilibili item whose only feed row is the pipeline's malformed YouTube
// template — the shape that left 39 items permanently unmatchable.
function dirtyBilibiliItem() {
  return [
    {
      match: "FROM item i",
      rows: [
        {
          id: 1204,
          platform: "bilibili",
          source_url: "https://www.bilibili.com/video/BV1xx411c7mD",
          author: "UP creator",
          thumbnail: "https://i0.hdslb.com/cover.jpg",
        },
      ],
    },
    { match: "SELECT feed_url FROM item_feed", rows: [{ feed_url: DIRTY_FEED }] },
    {
      match: "SELECT * FROM channel WHERE platform = ?",
      first: { id: 55, platform: "bilibili", channel_key: "30201875" },
    },
    { match: "SELECT view_count FROM item", first: { view_count: 12 } },
  ];
}

describe("channel link audit", () => {
  it("buckets unchanneled items and reports poll health for empty channels", async () => {
    const { env, executed } = fakeEnv([
      {
        match: "items_no_channel",
        first: { items_total: 2016, items_no_channel: 337, channels_total: 37, channel_links: 1712, channels_zero_items: 3 },
      },
      {
        match: "AS bucket, COUNT(*)",
        rows: [{ platform: "youtube", bucket: "no_feed_row", n: 183 }],
      },
      {
        match: "FROM channel ch",
        rows: [
          {
            id: 32,
            platform: "youtube",
            title: "Anthropic",
            feed_url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCrDwWp7EBBv4NwvScIpBDOA",
            source_url: null,
            created_at: "2026-08-01T00:00:00.000Z",
            follower_count: 1,
          },
        ],
      },
      {
        match: "FROM subscription",
        rows: [{ channel_id: 32, follow_id: 41, last_status: "ok", last_new_count: 0 }],
      },
    ]);

    const response = await app().request("/admin/channel-link-audit", undefined, env);
    const body = await response.json<{
      totals: { items_no_channel: number };
      items_no_channel_by_platform: { bucket: string }[];
      channels_zero_items: { id: number; follows: { follow_id: number }[] }[];
    }>();

    expect(response.status).toBe(200);
    expect(body.totals.items_no_channel).toBe(337);
    expect(body.items_no_channel_by_platform[0].bucket).toBe("no_feed_row");
    expect(body.channels_zero_items[0].follows).toEqual([
      { channel_id: 32, follow_id: 41, last_status: "ok", last_new_count: 0 },
    ]);
    // Excluded items are never counted as missing a channel.
    expect(executed.some((query) => query.sql.includes("i.status != 'excluded'"))).toBe(true);
  });
});

describe("item channel backfill", () => {
  it("rebuilds the channel from a malformed feed row and repairs the row", async () => {
    const { env, executed } = fakeEnv(dirtyBilibiliItem());

    const response = await app().request(
      "/admin/backfill-item-channels?phase=a",
      { method: "POST" },
      env,
    );
    const body = await response.json<{
      linked: number;
      phase_a: number;
      feed_rows_repaired: number;
      outcomes: { channel_id: number; channel_key: string; repaired_feed_url: string | null }[];
      skipped: unknown[];
    }>();

    expect(body).toMatchObject({ linked: 1, phase_a: 1, feed_rows_repaired: 1, skipped: [] });
    expect(body.outcomes[0]).toMatchObject({
      channel_id: 55,
      channel_key: "30201875",
      repaired_feed_url: DIRTY_FEED,
    });
    expect(
      executed.find((query) => query.sql.includes("INSERT OR IGNORE INTO channel_item"))?.bindings,
    ).toEqual([55, 1204]);
    // The dirty row is replaced by the uploader's real space URL.
    expect(
      executed.find((query) => query.sql.includes("DELETE FROM item_feed"))?.bindings,
    ).toEqual([1204, DIRTY_FEED]);
    expect(
      executed.find((query) => query.sql.includes("INSERT INTO item_feed"))?.bindings,
    ).toEqual([1204, "https://space.bilibili.com/30201875"]);
  });

  it("writes nothing on a dry run", async () => {
    const { env, executed } = fakeEnv(dirtyBilibiliItem());

    const response = await app().request(
      "/admin/backfill-item-channels?phase=a&dry_run=true",
      { method: "POST" },
      env,
    );
    const body = await response.json<{ dry_run: boolean; linked: number }>();

    expect(body).toMatchObject({ dry_run: true, linked: 1 });
    expect(
      executed.filter((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query.sql)),
    ).toEqual([]);
  });

  it("skips phase B work when only phase A was requested", async () => {
    const { env } = fakeEnv([
      {
        match: "FROM item i",
        rows: [
          {
            id: 1882,
            platform: "youtube",
            source_url: "https://www.youtube.com/watch?v=abc",
            author: null,
            thumbnail: null,
          },
        ],
      },
    ]);

    const response = await app().request(
      "/admin/backfill-item-channels?phase=a",
      { method: "POST" },
      env,
    );
    const body = await response.json<{ linked: number; skipped: { item_id: number; reason: string }[] }>();

    expect(body.linked).toBe(0);
    expect(body.skipped[0]).toMatchObject({ item_id: 1882 });
  });

  it("is idempotent: already-linked items are not candidates", async () => {
    const { env, executed } = fakeEnv([]);

    const response = await app().request(
      "/admin/backfill-item-channels",
      { method: "POST" },
      env,
    );
    const body = await response.json<{ scanned: number; linked: number; exhausted: boolean }>();

    expect(body).toMatchObject({ scanned: 0, linked: 0, exhausted: true });
    expect(
      executed[0].sql.includes("NOT EXISTS (SELECT 1 FROM channel_item ci WHERE ci.item_id = i.id)"),
    ).toBe(true);
  });
});
