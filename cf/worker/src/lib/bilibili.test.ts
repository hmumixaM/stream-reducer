import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

const mocks = vi.hoisted(() => ({
  fetchFeedEntries: vi.fn(),
}));

vi.mock("../pipeline/container", () => ({
  fetchFeedEntries: mocks.fetchFeedEntries,
}));

import {
  fetchBilibiliEntries,
  isBilibiliListUrl,
  parseBilibiliUrl,
} from "./bilibili";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseBilibiliUrl", () => {
  it("treats a bare /lists/<sid> as a season with a series fallback", () => {
    // A modern list URL with no ?type= is ambiguous: the same sid can be a 合集
    // (season) or a 系列 (series). Default to season, keep series as a fallback.
    expect(parseBilibiliUrl("https://space.bilibili.com/30201875/lists/6766139")).toEqual({
      kind: "season",
      mid: "30201875",
      sid: "6766139",
      fallbackKind: "series",
    });
  });

  it("honors ?type=series and keeps season as the fallback", () => {
    expect(
      parseBilibiliUrl("https://space.bilibili.com/14145636/lists/4891774?type=series"),
    ).toEqual({ kind: "series", mid: "14145636", sid: "4891774", fallbackKind: "season" });
  });

  it("supports the /lists?sid= query form", () => {
    expect(
      parseBilibiliUrl("https://space.bilibili.com/14145636/lists?sid=4891774&type=season"),
    ).toEqual({ kind: "season", mid: "14145636", sid: "4891774", fallbackKind: "series" });
  });

  it("keeps legacy collection/series URLs explicit (no fallback)", () => {
    expect(
      parseBilibiliUrl("https://space.bilibili.com/14145636/channel/seriesdetail?sid=4891774"),
    ).toEqual({ kind: "series", mid: "14145636", sid: "4891774" });
  });

  it("treats a bare UP主 space as a channel", () => {
    expect(parseBilibiliUrl("https://space.bilibili.com/30201875")).toEqual({
      kind: "space",
      mid: "30201875",
    });
  });

  it("returns null for a single video URL", () => {
    expect(parseBilibiliUrl("https://www.bilibili.com/video/BV1jTedzREds")).toBeNull();
  });
});

describe("isBilibiliListUrl", () => {
  it("is true for 合集/系列 lists", () => {
    expect(isBilibiliListUrl("https://space.bilibili.com/30201875/lists/6766139")).toBe(true);
    expect(
      isBilibiliListUrl("https://space.bilibili.com/14145636/channel/collectiondetail?sid=4891774"),
    ).toBe(true);
  });

  it("is false for a bare channel space or a single video", () => {
    expect(isBilibiliListUrl("https://space.bilibili.com/30201875")).toBe(false);
    expect(isBilibiliListUrl("https://www.bilibili.com/video/BV1jTedzREds")).toBe(false);
  });
});

describe("fetchBilibiliEntries", () => {
  it("enumerates uploader spaces through the WARP-backed container", async () => {
    mocks.fetchFeedEntries.mockResolvedValue([
      {
        external_id: "BV1jTedzREds",
        title: "Recent upload",
        url: "https://www.bilibili.com/video/BV1jTedzREds",
        duration_s: 700,
        published: "2026-08-13T00:00:00.000Z",
      },
    ]);

    const entries = await fetchBilibiliEntries({} as Env, {
      kind: "space",
      mid: "30201875",
    });

    expect(mocks.fetchFeedEntries).toHaveBeenCalledWith(
      expect.anything(),
      "https://space.bilibili.com/30201875/video",
    );
    expect(entries).toEqual([
      expect.objectContaining({
        guid: "BV1jTedzREds",
        link: "https://www.bilibili.com/video/BV1jTedzREds",
      }),
    ]);
  });
});
