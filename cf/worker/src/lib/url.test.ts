import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./url";

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
