import { describe, expect, it } from "vitest";
import { feedShardKey } from "./shard";

describe("feedShardKey", () => {
  it("keeps one channel on one instance so it stays warm", () => {
    const url = "https://www.youtube.com/channel/UCcEgieOZDQ2sJ3kzOa8vtCg/videos";
    expect(feedShardKey(url)).toBe(feedShardKey(url));
  });

  it("spreads concurrently polled channels across the shards", () => {
    const urls = [
      "https://www.youtube.com/channel/UCcEgieOZDQ2sJ3kzOa8vtCg/videos",
      "https://www.youtube.com/channel/UCrDwWp7EBBv4NwvScIpBDOA/videos",
      "https://space.bilibili.com/30201875",
      "https://space.bilibili.com/491461094",
      "https://www.youtube.com/channel/UCXZCJLdBC09xxGZ6gcdrc6A/videos",
      "https://feeds.megaphone.fm/acquired",
    ];
    const keys = new Set(urls.map((url) => feedShardKey(url)));
    expect(keys.size).toBeGreaterThan(1);
  });

  it("stays inside the configured shard count", () => {
    for (let i = 0; i < 50; i++) {
      expect(feedShardKey(`https://example.com/feed/${i}`, 3)).toMatch(/^feed-[0-2]$/);
    }
  });
});
