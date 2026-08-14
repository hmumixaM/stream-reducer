import { describe, expect, it } from "vitest";
import { nonItemUrlError, normalizeUrl } from "./url";

describe("normalizeUrl", () => {
  it("canonicalizes YouTube watch URLs for dedup", () => {
    expect(
      normalizeUrl("https://www.youtube.com/watch?v=abc123&utm_source=x&feature=share"),
    ).toBe("https://www.youtube.com/watch?v=abc123");
    expect(normalizeUrl("https://youtu.be/abc123?si=share")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
  });

  it("canonicalizes Bilibili BV URLs", () => {
    expect(
      normalizeUrl("https://www.bilibili.com/video/BV1abcdefgh/?vd_source=tracking"),
    ).toBe("https://www.bilibili.com/video/BV1abcdefgh");
  });
});

describe("nonItemUrlError", () => {
  it("turns down text that is not a link", () => {
    // A pasted headline used to become an item that failed at download time.
    expect(nonItemUrlError("【特朗普收入曝光，一年狂揽$22亿，竟然是靠…】")).toMatch(/isn't a link/);
    expect(nonItemUrlError("www.example.com/episode")).toMatch(/isn't a link/);
  });

  it("turns down non-http schemes", () => {
    expect(nonItemUrlError("javascript:alert(1)")).toMatch(/http\(s\)/);
    expect(nonItemUrlError("file:///etc/passwd")).toMatch(/http\(s\)/);
  });

  it("keeps accepting single episodes", () => {
    expect(nonItemUrlError("https://www.bilibili.com/video/BV1abcdefgh")).toBeNull();
    expect(nonItemUrlError("https://www.youtube.com/watch?v=abc123")).toBeNull();
    expect(nonItemUrlError("https://www.xiaoyuzhoufm.com/episode/abc")).toBeNull();
  });
});
