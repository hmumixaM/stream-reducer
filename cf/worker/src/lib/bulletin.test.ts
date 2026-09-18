import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { enqueueBulletinTranslations } from "./bulletin";

describe("Chinese bulletin backfill", () => {
  it("queues missing introductions without duplicating completed or active work", async () => {
    const existing = [
      { item_id: 1, status: "done", headline: "", tldr: "" },
      { item_id: 2, status: "done", headline: "标题", tldr: "概览" },
      { item_id: 3, status: "processing", headline: "", tldr: "" },
      { item_id: 4, status: "queued", headline: "", tldr: "" },
      { item_id: 5, status: "error", headline: "", tldr: "" },
    ];
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const batch = vi.fn().mockResolvedValue([]);
    const env = {
      DB: {
        prepare() { return { bind() { return this; }, async all() { return { results: existing }; } }; },
        batch,
      },
      PIPELINE: { sendBatch },
    } as unknown as Env;
    expect(await enqueueBulletinTranslations(env, [1, 2, 3, 4, 5, 6, 1], "zh")).toBe(3);
    expect(sendBatch).toHaveBeenCalledWith([1, 5, 6].map((item_id) => ({ body: { kind: "bulletin_translate", item_id, lang: "zh" } })));
    expect(batch.mock.calls[0][0]).toHaveLength(3);
  });
});
