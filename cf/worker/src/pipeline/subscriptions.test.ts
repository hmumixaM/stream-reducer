import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import type { SubscriptionRow } from "../db";

const mocks = vi.hoisted(() => ({
  addUrlToLibrary: vi.fn(),
  fetchFeed: vi.fn(),
  resolveFeedUrl: vi.fn(),
  fetchMetadata: vi.fn(),
}));

vi.mock("../lib/ingest", () => ({
  addUrlToLibrary: mocks.addUrlToLibrary,
}));

vi.mock("../lib/feed", () => ({
  fetchFeed: mocks.fetchFeed,
  resolveFeedUrl: mocks.resolveFeedUrl,
}));

vi.mock("./container", () => ({
  fetchMetadata: mocks.fetchMetadata,
}));

import { pollDueSubscriptions, pollSubscription } from "./subscriptions";

interface RecordedQuery {
  sql: string;
  bindings: unknown[];
}

type PollTestRow = SubscriptionRow & {
  channel_feed_url: string | null;
  channel_title: string | null;
  channel_image_url: string | null;
};

function subscription(overrides: Partial<PollTestRow> = {}): PollTestRow {
  return {
    id: 7,
    user_id: 11,
    channel_id: null,
    platform: "rss",
    feed_url: "https://legacy.example/feed.xml",
    title: null,
    interval_minutes: 60,
    window_days: 90,
    min_published_at: null,
    enabled: 1,
    last_checked_at: null,
    last_seen_guid: null,
    last_status: null,
    last_error: null,
    last_entry_count: 0,
    last_new_count: 0,
    consecutive_failures: 0,
    folder_id: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    channel_feed_url: null,
    channel_title: null,
    channel_image_url: null,
    ...overrides,
  };
}

function fakeEnv(row: ReturnType<typeof subscription>) {
  const queries: RecordedQuery[] = [];
  const sends: unknown[] = [];
  const DB = {
    prepare(sql: string) {
      const query: RecordedQuery = { sql, bindings: [] };
      queries.push(query);
      const statement = {
        bind(...bindings: unknown[]) {
          query.bindings = bindings;
          return statement;
        },
        async first() {
          return sql.includes("SELECT subscription.*") ? row : null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
      return statement;
    },
  };
  return {
    env: {
      DB,
      PIPELINE: { send: async (message: unknown) => { sends.push(message); } },
    } as unknown as Env,
    queries,
    sends,
  };
}

const feed = {
  title: "Shared show title",
  entries: [{
    title: "Episode",
    link: "https://example.com/episodes/1",
    guid: "episode-1",
    published: "2026-08-01T00:00:00.000Z",
    audio: "https://cdn.example.com/episodes/1.mp3",
    duration_s: 700,
    thumbnail: "https://cdn.example.com/show.jpg",
  }],
};

describe("subscription channel polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchFeed.mockResolvedValue(feed);
    mocks.resolveFeedUrl.mockImplementation(async (url: string) => url);
    mocks.addUrlToLibrary.mockResolvedValue({ item: { id: 19 } });
    mocks.fetchMetadata.mockResolvedValue({ duration_s: null });
  });

  it("uses a migrated channel feed and passes its channel through ingest", async () => {
    const { env, queries } = fakeEnv(subscription({
      channel_id: 5,
      channel_feed_url: "https://canonical.example/feed.xml",
      channel_title: "Old shared title",
    }));

    await expect(pollSubscription(env, 7)).resolves.toBe(1);

    expect(mocks.fetchFeed).toHaveBeenCalledWith(env, "https://canonical.example/feed.xml");
    expect(mocks.addUrlToLibrary).toHaveBeenCalledWith(
      env,
      11,
      "https://cdn.example.com/episodes/1.mp3",
      expect.objectContaining({
        subscriptionId: 7,
        feedUrl: "https://canonical.example/feed.xml",
        channelId: 5,
      }),
    );
    const metadataUpdate = queries.find((query) => query.sql.includes("UPDATE channel"));
    expect(metadataUpdate?.bindings).toEqual([
      "Shared show title",
      "https://cdn.example.com/show.jpg",
      expect.any(String),
      5,
    ]);
  });

  it("falls back to the legacy feed for an unmigrated follow", async () => {
    const { env } = fakeEnv(subscription());

    await expect(pollSubscription(env, 7)).resolves.toBe(1);

    expect(mocks.fetchFeed).toHaveBeenCalledWith(env, "https://legacy.example/feed.xml");
    expect(mocks.addUrlToLibrary).toHaveBeenCalledWith(
      env,
      11,
      "https://cdn.example.com/episodes/1.mp3",
      expect.objectContaining({
        feedUrl: "https://legacy.example/feed.xml",
        channelId: null,
      }),
    );
  });

  it("does not advance the cursor past a failed ingest entry", async () => {
    const { env, queries } = fakeEnv(subscription());
    mocks.fetchFeed.mockResolvedValue({
      title: "Shared show title",
      entries: [
        { ...feed.entries[0], guid: "newest", link: "https://example.com/newest" },
        { ...feed.entries[0], guid: "failed", link: "https://example.com/failed" },
        { ...feed.entries[0], guid: "oldest", link: "https://example.com/oldest" },
      ],
    });
    mocks.addUrlToLibrary
      .mockReset()
      .mockResolvedValueOnce({ item: { id: 17 } })
      .mockRejectedValueOnce(new Error("transient D1 failure"));

    await expect(pollSubscription(env, 7)).resolves.toBe(1);

    expect(mocks.addUrlToLibrary).toHaveBeenCalledTimes(2);
    const successUpdate = queries.find((query) =>
      query.sql.includes("last_seen_guid = COALESCE"),
    );
    expect(successUpdate?.bindings[1]).toBe("oldest");
    expect(
      queries.some((query) => query.sql.includes("consecutive_failures = consecutive_failures + 1")),
    ).toBe(true);
  });

  it("does not poll a disabled follow", async () => {
    const { env } = fakeEnv(subscription({ enabled: 0 }));

    await expect(pollSubscription(env, 7)).resolves.toBe(0);

    expect(mocks.fetchFeed).not.toHaveBeenCalled();
    expect(mocks.addUrlToLibrary).not.toHaveBeenCalled();
  });

  it("skips clips shorter than the floor and keeps the rest", async () => {
    const { env } = fakeEnv(subscription());
    mocks.fetchFeed.mockResolvedValue({
      title: "Shared show title",
      entries: [
        { ...feed.entries[0], guid: "long", link: "https://example.com/long", duration_s: 301 },
        { ...feed.entries[0], guid: "clip", link: "https://example.com/clip", duration_s: 299 },
      ],
    });

    await expect(pollSubscription(env, 7)).resolves.toBe(1);

    expect(mocks.addUrlToLibrary).toHaveBeenCalledTimes(1);
    expect(mocks.addUrlToLibrary.mock.calls[0][2]).toBe("https://cdn.example.com/episodes/1.mp3");
  });

  it("asks the source for a duration the feed omitted", async () => {
    const { env } = fakeEnv(subscription({ platform: "bilibili" }));
    mocks.fetchFeed.mockResolvedValue({
      title: "UP creator",
      entries: [
        {
          title: null,
          link: "https://www.bilibili.com/video/BV1clip",
          guid: "BV1clip",
          published: null,
          audio: null,
          duration_s: null,
        },
        {
          title: null,
          link: "https://www.bilibili.com/video/BV1full",
          guid: "BV1full",
          published: null,
          audio: null,
          duration_s: null,
        },
      ],
    });
    mocks.fetchMetadata.mockImplementation(async (_env: unknown, url: string) =>
      url.endsWith("BV1clip") ? { duration_s: 47 } : { duration_s: 1800 },
    );

    await expect(pollSubscription(env, 7)).resolves.toBe(1);

    expect(mocks.fetchMetadata).toHaveBeenCalledTimes(2);
    expect(mocks.addUrlToLibrary).toHaveBeenCalledTimes(1);
    expect(mocks.addUrlToLibrary.mock.calls[0][2]).toBe("https://www.bilibili.com/video/BV1full");
  });

  it("keeps an entry whose duration cannot be resolved", async () => {
    const { env } = fakeEnv(subscription({ platform: "bilibili" }));
    mocks.fetchFeed.mockResolvedValue({
      title: "UP creator",
      entries: [{
        title: null,
        link: "https://www.bilibili.com/video/BV1unknown",
        guid: "BV1unknown",
        published: null,
        audio: null,
        duration_s: null,
      }],
    });
    mocks.fetchMetadata.mockRejectedValue(new Error("container 503"));

    await expect(pollSubscription(env, 7)).resolves.toBe(1);

    expect(mocks.addUrlToLibrary).toHaveBeenCalledTimes(1);
  });

  it("selects only enabled follows while retaining the migration fallback", async () => {
    const { env, queries } = fakeEnv(subscription());

    await pollDueSubscriptions(env);

    const dueQuery = queries[0].sql;
    expect(dueQuery).toContain("LEFT JOIN channel");
    expect(dueQuery).toContain("subscription.enabled = 1");
    expect(dueQuery).toContain("COALESCE(channel.feed_url, subscription.feed_url)");
  });
});
