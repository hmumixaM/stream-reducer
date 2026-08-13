import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

const mocks = vi.hoisted(() => ({
  first: vi.fn(),
  upsertItem: vi.fn(),
  fetchMetadata: vi.fn(),
  linkChannelItem: vi.fn(),
  resolveChannelIdentity: vi.fn(),
  upsertChannel: vi.fn(),
}));

vi.mock("../db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../db")>(),
  first: mocks.first,
  upsertItem: mocks.upsertItem,
}));

vi.mock("../pipeline/container", () => ({
  fetchMetadata: mocks.fetchMetadata,
}));

vi.mock("./channels", () => ({
  linkChannelItem: mocks.linkChannelItem,
  resolveChannelIdentity: mocks.resolveChannelIdentity,
  upsertChannel: mocks.upsertChannel,
}));

import { addUrlToLibrary, recomputePriority } from "./ingest";

interface RecordedQuery {
  sql: string;
  bindings: unknown[];
}

function fakeEnv() {
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
      MEDIA: { put: vi.fn() },
      PIPELINE: { send: async (message: unknown) => { sends.push(message); } },
    } as unknown as Env,
    queries,
    sends,
  };
}

const item = {
  id: 19,
  source_url: "https://www.youtube.com/watch?v=video123",
  platform: "youtube",
  status: "done",
  view_count: 100,
};

function mockAddQueries() {
  mocks.first
    .mockResolvedValueOnce(null) // no existing user_item
    .mockResolvedValueOnce({ n: 1 }) // request_count
    .mockResolvedValueOnce({ n: 0 }) // interest_count
    .mockResolvedValueOnce({ n: 2 }) // subscriber_demand
    .mockResolvedValueOnce({ view_count: 100 })
    .mockResolvedValueOnce(item); // refreshed item
}

describe("channel-aware ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertItem.mockResolvedValue({ item, created: true });
    mocks.fetchMetadata.mockResolvedValue({
      title: "Video",
      author: "Creator",
      thumbnail: null,
      channel_id: "UCabcdefghijklmnopqrstuv",
    });
    mocks.resolveChannelIdentity.mockResolvedValue({
      platform: "youtube",
      channelKey: "UCabcdefghijklmnopqrstuv",
      keyKind: "provider_id",
      feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
      sourceUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
    });
    mocks.upsertChannel.mockResolvedValue({
      id: 31,
      feed_url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
    });
  });

  it("creates and links a shared channel for a manually added YouTube video", async () => {
    const { env } = fakeEnv();
    mockAddQueries();

    await addUrlToLibrary(env, 11, item.source_url);

    expect(mocks.resolveChannelIdentity).toHaveBeenCalledWith(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
    );
    expect(mocks.upsertChannel).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ channelKey: "UCabcdefghijklmnopqrstuv" }),
      { title: "Creator", imageUrl: null },
    );
    expect(mocks.linkChannelItem).toHaveBeenCalledWith(env, 31, 19);
  });

  it("creates and links a shared channel for a manually added Bilibili video", async () => {
    const { env } = fakeEnv();
    mockAddQueries();
    mocks.fetchMetadata.mockResolvedValue({
      title: "Video",
      author: "UP creator",
      thumbnail: null,
      channel_id: "30201875",
    });
    mocks.resolveChannelIdentity.mockResolvedValue({
      platform: "bilibili",
      channelKey: "30201875",
      keyKind: "provider_id",
      feedUrl: "https://space.bilibili.com/30201875",
      sourceUrl: "https://space.bilibili.com/30201875",
    });
    mocks.upsertChannel.mockResolvedValue({
      id: 32,
      feed_url: "https://space.bilibili.com/30201875",
    });

    await addUrlToLibrary(env, 11, "https://www.bilibili.com/video/BV1xx411c7mD");

    expect(mocks.resolveChannelIdentity).toHaveBeenCalledWith(
      "https://space.bilibili.com/30201875",
    );
    expect(mocks.upsertChannel).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ channelKey: "30201875" }),
      { title: "UP creator", imageUrl: null },
    );
    expect(mocks.linkChannelItem).toHaveBeenCalledWith(env, 32, 19);
  });

  it("links the channel supplied by subscription ingest", async () => {
    const { env } = fakeEnv();
    mockAddQueries();

    await addUrlToLibrary(env, 11, item.source_url, {
      channelId: 44,
      feedUrl: "https://example.com/feed.xml",
      meta: { title: "Feed title" },
    });

    expect(mocks.fetchMetadata).not.toHaveBeenCalled();
    expect(mocks.upsertChannel).not.toHaveBeenCalled();
    expect(mocks.linkChannelItem).toHaveBeenCalledWith(env, 44, 19);
  });

  it("counts distinct followers across channel and legacy feed links", async () => {
    const { env, queries } = fakeEnv();
    mocks.first
      .mockResolvedValueOnce({ n: 1 })
      .mockResolvedValueOnce({ n: 0 })
      .mockResolvedValueOnce({ n: 4 })
      .mockResolvedValueOnce({ view_count: 100 });

    await recomputePriority(env, 19);

    const demandQuery = queries.find((query) =>
      query.sql.includes("COUNT(DISTINCT user_id)"),
    );
    expect(demandQuery?.sql).toContain("channel_item");
    expect(demandQuery?.sql).toContain("item_feed");
    expect(demandQuery?.bindings).toEqual([19, 19]);
    const priorityUpdate = queries.find((query) =>
      query.sql.includes("UPDATE item SET request_count"),
    );
    expect(priorityUpdate?.bindings[2]).toBe(4);
  });
});
