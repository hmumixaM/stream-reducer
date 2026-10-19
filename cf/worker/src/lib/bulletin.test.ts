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
      BULLETIN_JOBS: { sendBatch },
    } as unknown as Env;
    expect(await enqueueBulletinTranslations(env, [1, 2, 3, 4, 5, 6, 1], "zh")).toBe(3);
    expect(sendBatch).toHaveBeenCalledWith(Array.from({ length: 3 }, () => ({ body: { kind: "bulletin_drain" } })));
    expect(batch.mock.calls[0][0]).toHaveLength(3);
  });
});

it("queues English only for non-English sources and leaves completed translations alone", async () => {
  const queued: unknown[][] = [];
  const env = { DB: {
    prepare(sql: string) {
      let args: unknown[] = [];
      return { bind(...values: unknown[]) { args = values; return this; },
        async all() { return { results: sql.includes("FROM transcript") ? [{ item_id: 1, language: "en-US" }] : [{ item_id: 2, status: "done", headline: "Ready", tldr: "Ready overview" }] }; },
        args: () => args,
      };
    },
    async batch(statements: { args: () => unknown[] }[]) { queued.push(...statements.map((s) => s.args())); },
  }, BULLETIN_JOBS: { sendBatch: vi.fn() } } as unknown as Env;
  expect(await enqueueBulletinTranslations(env, [1, 2, 3], "en")).toBe(1);
  expect(queued).toHaveLength(1);
  expect(queued[0].slice(0, 2)).toEqual([3, "en"]);
});
