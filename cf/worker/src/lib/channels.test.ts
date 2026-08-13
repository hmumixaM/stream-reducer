import { describe, expect, it } from "vitest";
import type { ChannelFollowRow, ChannelRow } from "../db";
import type { Env } from "../env";
import {
  deriveChannelIdentity,
  findUnmigratedUserFollowsByIdentity,
  groupSelectedResolvedFollows,
  mergeFollowsIntoChannel,
  mergeFollowState,
  normalizeChannelUrl,
  upsertChannel,
} from "./channels";

const YOUTUBE_ID = "UCaaaaaaaaaaaaaaaaaaaaaa";

function follow(
  id: number,
  overrides: Partial<ChannelFollowRow> = {},
): ChannelFollowRow {
  return {
    id,
    user_id: 1,
    channel_id: null,
    platform: "rss",
    feed_url: "https://example.com/feed.xml",
    title: null,
    interval_minutes: 60,
    window_days: 90,
    min_published_at: null,
    enabled: 0,
    last_checked_at: null,
    last_seen_guid: null,
    last_status: null,
    last_error: null,
    last_entry_count: 0,
    last_new_count: 0,
    consecutive_failures: 0,
    folder_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("channel identity", () => {
  it("uses the YouTube provider id regardless of feed parameter order", () => {
    const first = deriveChannelIdentity(
      `https://youtube.com/channel/${YOUTUBE_ID}/videos?utm_source=test`,
      `https://youtube.com/feeds/videos.xml?z=1&channel_id=${YOUTUBE_ID}`,
    );
    const second = deriveChannelIdentity(
      "https://www.youtube.com/@resolved-handle/",
      `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_ID}`,
    );

    expect(first.channelKey).toBe(YOUTUBE_ID);
    expect(second.channelKey).toBe(YOUTUBE_ID);
    expect(first.feedUrl).toBe(second.feedUrl);
    expect(first.keyKind).toBe("provider_id");
  });

  it("does not treat lookalike domains as YouTube channel feeds", () => {
    const identity = deriveChannelIdentity(
      `https://evilyoutube.com/feeds/videos.xml?channel_id=${YOUTUBE_ID}`,
      `https://evilyoutube.com/feeds/videos.xml?channel_id=${YOUTUBE_ID}`,
    );
    expect(identity.platform).toBe("rss");
    expect(identity.channelKey).toContain("evilyoutube.com");
  });

  it("maps Bilibili spaces and owner lists to the same mid", () => {
    const space = deriveChannelIdentity(
      "https://space.bilibili.com/12345/video/",
      "https://space.bilibili.com/12345/video/",
    );
    const list = deriveChannelIdentity(
      "https://space.bilibili.com/12345/lists/99?type=series&spm_id_from=333",
      "https://space.bilibili.com/12345/lists/99?type=series&spm_id_from=333",
    );

    expect(space.channelKey).toBe("12345");
    expect(list.channelKey).toBe("12345");
    expect(list.feedUrl).toBe("https://space.bilibili.com/12345");
    expect(list.sourceUrl).toBe(
      "https://space.bilibili.com/12345/lists/99?type=series",
    );
  });

  it("normalizes RSS tracking, parameter order, and trailing slashes", () => {
    const first = deriveChannelIdentity(
      "https://EXAMPLE.com/show/?b=2&utm_source=x&a=1",
      "https://EXAMPLE.com/show/?b=2&utm_source=x&a=1",
    );
    const second = deriveChannelIdentity(
      "https://example.com/show?a=1&b=2",
      "https://example.com/show?a=1&b=2",
    );

    expect(first.channelKey).toBe(second.channelKey);
    expect(first.channelKey).toBe("https://example.com/show?a=1&b=2");
    expect(normalizeChannelUrl("https://example.com/feed/?fbclid=x")).toBe(
      "https://example.com/feed",
    );
  });

  it("dedupes Apple discovery and the resolved raw RSS feed", () => {
    const feed = "https://feeds.example.com/show.xml";
    const apple = deriveChannelIdentity(
      "https://podcasts.apple.com/us/podcast/show/id123456",
      feed,
    );
    const raw = deriveChannelIdentity(feed, feed);

    expect(apple.platform).toBe("rss");
    expect(apple.channelKey).toBe(raw.channelKey);
    expect(apple.platform).toBe(raw.platform);
  });
});

describe("legacy follow merge", () => {
  it("finds a legacy Bilibili list as an alias of its owner channel", async () => {
    const alias = follow(9, {
      platform: "bilibili",
      feed_url: "https://space.bilibili.com/12345/lists/99?type=series",
    });
    const env = {
      DB: {
        prepare() {
          const statement = {
            bind() {
              return statement;
            },
            async all() {
              return { results: [alias] };
            },
          };
          return statement;
        },
      },
    } as unknown as Env;

    const matches = await findUnmigratedUserFollowsByIdentity(env, 1, {
      platform: "bilibili",
      channelKey: "12345",
    });

    expect(matches.map((row) => row.id)).toEqual([9]);
  });

  it("expands a selected migration identity across cursor boundaries", () => {
    const identity = deriveChannelIdentity(
      "https://example.com/feed.xml",
      "https://example.com/feed.xml",
    );
    const groups = groupSelectedResolvedFollows(new Set([3]), [
      { follow: follow(3), identity },
      { follow: follow(103, { feed_url: "https://example.com/feed.xml?utm_source=old" }), identity },
      {
        follow: follow(104, { user_id: 2, feed_url: "https://example.com/feed.xml" }),
        identity,
      },
    ]);

    expect([...groups.values()]).toHaveLength(1);
    expect([...groups.values()][0].map((entry) => entry.follow.id)).toEqual([3, 103]);
  });

  it("keeps the lowest id and combines state without losing poll health", () => {
    const merged = mergeFollowState([
      follow(8, {
        enabled: 1,
        window_days: 180,
        min_published_at: "2025-01-01T00:00:00.000Z",
        folder_id: 4,
        last_checked_at: "2026-05-01T00:00:00.000Z",
        last_seen_guid: "newest",
        last_status: "ok",
        last_new_count: 2,
      }),
      follow(3, {
        window_days: 30,
        min_published_at: "2026-01-01T00:00:00.000Z",
        folder_id: 2,
      }),
    ]);

    expect(merged).toMatchObject({
      survivorId: 3,
      duplicateIds: [8],
      enabled: 1,
      windowDays: 180,
      minPublishedAt: "2025-01-01T00:00:00.000Z",
      folderId: 2,
      folderConflict: true,
      health: {
        last_seen_guid: "newest",
        last_status: "ok",
        last_new_count: 2,
      },
    });
  });

  it("merges references and alias item links in one atomic batch", async () => {
    const attached = follow(3, { channel_id: 12 });
    let batched: { sql: string; bindings: unknown[] }[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          const query = { sql, bindings: [] as unknown[] };
          const statement = {
            sql,
            get bindings() {
              return query.bindings;
            },
            bind(...bindings: unknown[]) {
              query.bindings = bindings;
              return statement;
            },
            async run() {
              return { success: true };
            },
            async first() {
              return sql.startsWith("SELECT * FROM subscription") ? attached : null;
            },
          };
          return statement;
        },
        async batch(statements: unknown[]) {
          batched = statements as typeof batched;
          return [];
        },
      },
    } as unknown as Env;
    const channel = {
      id: 12,
      platform: "youtube",
      channel_key: YOUTUBE_ID,
      key_kind: "provider_id",
      feed_url: `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_ID}`,
      source_url: null,
      title: null,
      image_url: null,
      created_at: "",
      updated_at: "",
    } satisfies ChannelRow;

    await mergeFollowsIntoChannel(env, channel, [
      follow(8, { feed_url: channel.feed_url }),
      follow(3, { feed_url: "https://youtube.com/@alias" }),
    ]);

    const batchQueries = batched;
    expect(batchQueries.some((query) => query.sql.includes("DELETE FROM subscription"))).toBe(true);
    expect(batchQueries.filter((query) => query.sql.includes("INSERT OR IGNORE INTO channel_item")))
      .toHaveLength(2);
    const followUpdate = batchQueries.find((query) =>
      query.sql.includes("SET channel_id = ?"),
    );
    expect(followUpdate?.sql).not.toContain("feed_url =");
  });

  it("does not overwrite an existing channel source URL on upsert", async () => {
    const recordedSql: string[] = [];
    const row = {
      id: 12,
      platform: "youtube",
      channel_key: YOUTUBE_ID,
      key_kind: "provider_id",
      feed_url: `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_ID}`,
      source_url: `https://www.youtube.com/channel/${YOUTUBE_ID}`,
      title: null,
      image_url: null,
      created_at: "",
      updated_at: "",
    } satisfies ChannelRow;
    const env = {
      DB: {
        prepare(sql: string) {
          recordedSql.push(sql);
          const statement = {
            bind() {
              return statement;
            },
            async run() {
              return { success: true };
            },
            async first() {
              return sql.startsWith("SELECT * FROM channel") ? row : null;
            },
          };
          return statement;
        },
      },
    } as unknown as Env;

    await upsertChannel(env, {
      platform: "youtube",
      channelKey: YOUTUBE_ID,
      keyKind: "provider_id",
      feedUrl: row.feed_url,
      sourceUrl: "https://www.youtube.com/@different-source",
    });

    expect(recordedSql[0]).toContain(
      "source_url = COALESCE(channel.source_url, excluded.source_url)",
    );
  });
});
