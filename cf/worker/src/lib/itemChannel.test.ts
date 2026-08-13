import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

const mocks = vi.hoisted(() => ({
  linkChannelItem: vi.fn(),
  resolveChannelIdentity: vi.fn(),
  upsertChannel: vi.fn(),
  fetchXiaoyuzhouPodcastId: vi.fn(),
  fetchYoutubeVideoChannelId: vi.fn(),
}));

vi.mock("./channels", () => ({
  linkChannelItem: mocks.linkChannelItem,
  resolveChannelIdentity: mocks.resolveChannelIdentity,
  upsertChannel: mocks.upsertChannel,
}));

vi.mock("./feed", () => ({
  fetchXiaoyuzhouPodcastId: mocks.fetchXiaoyuzhouPodcastId,
  fetchYoutubeVideoChannelId: mocks.fetchYoutubeVideoChannelId,
}));

import {
  appleShowUrl,
  attachItemChannel,
  channelUrlFromFeedRow,
  channelUrlFromMetadata,
  resolveItemChannelIdentity,
  youtubeChannelFeed,
} from "./itemChannel";

const UC = "UCabcdefghijklmnopqrstuv";

function fakeEnv() {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const query = { sql, bindings: [] as unknown[] };
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
    },
  } as unknown as Env;
  return { env, queries };
}

describe("youtubeChannelFeed", () => {
  it("builds the canonical feed URL for a real channel id", () => {
    expect(youtubeChannelFeed(UC)).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`,
    );
  });

  it("rejects ids that are not YouTube channel ids", () => {
    // The pipeline used to pass Bilibili uploader mids through here, writing feed
    // rows that could never match a real channel.
    expect(youtubeChannelFeed("30201875")).toBeNull();
    expect(youtubeChannelFeed("UCtooshort")).toBeNull();
    expect(youtubeChannelFeed(null)).toBeNull();
  });
});

describe("channelUrlFromMetadata", () => {
  it("derives a Bilibili space URL from an uploader mid", () => {
    expect(
      channelUrlFromMetadata("bilibili", "https://www.bilibili.com/video/BV1xx411c7mD", {
        channel_id: "30201875",
      }),
    ).toBe("https://space.bilibili.com/30201875");
  });

  it("never puts a Bilibili mid into the YouTube template", () => {
    expect(
      channelUrlFromMetadata("youtube", "https://www.youtube.com/watch?v=abc", {
        channel_id: "30201875",
      }),
    ).toBeNull();
  });

  it("derives the Apple show page from an episode URL", () => {
    expect(
      channelUrlFromMetadata(
        "apple_podcast",
        "https://podcasts.apple.com/us/podcast/acquired/id1050462261?i=1000770993226",
        null,
      ),
    ).toBe("https://podcasts.apple.com/us/podcast/acquired/id1050462261");
  });

  it("has no channel identity for a bare RSS episode", () => {
    expect(channelUrlFromMetadata("rss", "https://example.com/audio/ep1.mp3", null)).toBeNull();
  });
});

describe("appleShowUrl", () => {
  it("ignores URLs without a show id", () => {
    expect(appleShowUrl("https://podcasts.apple.com/us/browse")).toBeNull();
    expect(appleShowUrl("【特朗普收入曝光】")).toBeNull();
  });
});

describe("channelUrlFromFeedRow", () => {
  it("reads a YouTube channel id back out of a stored feed row", () => {
    expect(
      channelUrlFromFeedRow("youtube", `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`),
    ).toEqual({ channelUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}` });
  });

  it("recovers a Bilibili mid from the malformed YouTube template and flags the repair", () => {
    const dirty = "https://www.youtube.com/feeds/videos.xml?channel_id=30201875";
    expect(channelUrlFromFeedRow("bilibili", dirty)).toEqual({
      channelUrl: "https://space.bilibili.com/30201875",
      repairs: dirty,
    });
  });

  it("refuses to guess when a numeric template belongs to a YouTube item", () => {
    expect(
      channelUrlFromFeedRow("youtube", "https://www.youtube.com/feeds/videos.xml?channel_id=30201875"),
    ).toBeNull();
  });

  it("passes a real feed/space URL through", () => {
    expect(channelUrlFromFeedRow("bilibili", "https://space.bilibili.com/30201875")).toEqual({
      channelUrl: "https://space.bilibili.com/30201875",
    });
    expect(channelUrlFromFeedRow("rss", "not a url")).toBeNull();
  });
});

describe("resolveItemChannelIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps every 小宇宙 episode of a show on one channel", async () => {
    mocks.fetchXiaoyuzhouPodcastId.mockResolvedValue("6021f7fcc9f9e77e1a0d5f2b");

    const identity = await resolveItemChannelIdentity(
      "xiaoyuzhou",
      "https://www.xiaoyuzhoufm.com/episode/64b7b0e0c1a2b3d4e5f60718",
      null,
    );

    expect(identity).toEqual({
      platform: "xiaoyuzhou",
      channelKey: "6021f7fcc9f9e77e1a0d5f2b",
      keyKind: "provider_id",
      feedUrl: "https://www.xiaoyuzhoufm.com/podcast/6021f7fcc9f9e77e1a0d5f2b",
      sourceUrl: "https://www.xiaoyuzhoufm.com/podcast/6021f7fcc9f9e77e1a0d5f2b",
    });
    // 小宇宙 has no RSS, so the show page is the channel's canonical URL and the
    // show id (not a per-episode URL) is the dedup key.
    expect(mocks.resolveChannelIdentity).not.toHaveBeenCalled();
  });

  it("reads the show id straight off a 小宇宙 show URL", async () => {
    const identity = await resolveItemChannelIdentity(
      "xiaoyuzhou",
      "https://www.xiaoyuzhoufm.com/podcast/6021f7fcc9f9e77e1a0d5f2b",
      null,
    );

    expect(identity?.channelKey).toBe("6021f7fcc9f9e77e1a0d5f2b");
    expect(mocks.fetchXiaoyuzhouPodcastId).not.toHaveBeenCalled();
  });
});

describe("attachItemChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveChannelIdentity.mockResolvedValue({
      platform: "youtube",
      channelKey: UC,
      keyKind: "provider_id",
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`,
      sourceUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`,
    });
    mocks.upsertChannel.mockResolvedValue({ id: 31 });
  });

  it("writes both relationship rows so the item is visible to the UI and to demand counting", async () => {
    const { env, queries } = fakeEnv();

    const channelId = await attachItemChannel(
      env,
      { id: 19, platform: "youtube", source_url: "https://www.youtube.com/watch?v=abc" },
      { channel_id: UC, author: "Creator", thumbnail: "https://img.example/cover.jpg" },
    );

    expect(channelId).toBe(31);
    expect(mocks.upsertChannel).toHaveBeenCalledWith(env, expect.objectContaining({ channelKey: UC }), {
      title: "Creator",
      imageUrl: "https://img.example/cover.jpg",
    });
    expect(mocks.linkChannelItem).toHaveBeenCalledWith(env, 31, 19);
    const feedInsert = queries.find((query) => query.sql.includes("INSERT INTO item_feed"));
    expect(feedInsert?.bindings).toEqual([
      19,
      `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`,
    ]);
  });

  it("leaves an item alone when its platform carries no channel identity", async () => {
    const { env, queries } = fakeEnv();

    const channelId = await attachItemChannel(
      env,
      { id: 20, platform: "rss", source_url: "https://example.com/audio/ep1.mp3" },
      { author: "Someone" },
    );

    expect(channelId).toBeNull();
    expect(mocks.upsertChannel).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });
});
