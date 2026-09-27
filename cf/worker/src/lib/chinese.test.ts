import { describe, expect, it } from "vitest";
import { isPredominantlyChinese } from "./chinese";

describe("isPredominantlyChinese", () => {
  it("recognizes a Chinese summary", () => {
    expect(isPredominantlyChinese("这是一段已经用中文写好的总结，正文本身就是中文，不需要再生成一版。")).toBe(true);
  });

  it("leaves English and short fragments alone", () => {
    expect(isPredominantlyChinese("This summary is written in English and should still be translated.")).toBe(false);
    expect(isPredominantlyChinese("中文")).toBe(false);
  });
});
