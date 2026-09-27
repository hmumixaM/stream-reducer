import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { enqueueAutomaticTranslations, enqueueLibraryContentTranslations, enqueuePreferredContentTranslation } from "./autoTranslate";

describe("automatic collection translations", () => {
  it("deduplicates languages across collections and queues each once", async () => {
    const sends: unknown[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            bind() {
              return statement;
            },
            async all() {
              if (!sql.includes("FROM collection_item")) return { results: [] };
              return {
                results: [
                  { auto_translate_langs: '["zh"]' },
                  { auto_translate_langs: '["zh","ja"]' },
                ],
              };
            },
            async first() {
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
          return statement;
        },
      },
      PIPELINE: {
        async send(message: unknown) {
          sends.push(message);
        },
      },
    } as unknown as Env;

    expect(await enqueueAutomaticTranslations(env, 42)).toEqual(["zh", "ja"]);
    expect(sends).toEqual([
      { kind: "translate", item_id: 42, lang: "zh" },
      { kind: "translate", item_id: 42, lang: "ja" },
    ]);
  });

  it("queues a full Chinese edition for a library that asked for it", async () => {
    const sends: unknown[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            bind() { return statement; },
            async all() {
              return {
                results: sql.includes("FROM user_item")
                  ? [
                    { id: 7, sample: "This English summary covers markets, policy, and the week ahead in enough detail." },
                    { id: 8, sample: "Another English summary about earnings, rates, and what investors are watching." },
                    { id: 9, sample: "这是一段已经用中文写好的总结，正文本身就是中文，不需要再生成一版中文全文。" },
                  ]
                  : [],
              };
            },
            async first() {
              if (sql.includes("preferred_language")) return { ok: 1 };
              if (sql.includes("AS sample")) return { sample: "This English summary is not already Chinese, so a Chinese edition can be queued." };
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
          return statement;
        },
        async batch(statements: unknown[]) {
          return statements.map(() => ({ meta: { changes: 1 } }));
        },
      },
      PIPELINE: {
        async send(message: unknown) { sends.push(message); },
        async sendBatch(messages: unknown[]) { sends.push(...messages); },
      },
    } as unknown as Env;

    expect(await enqueueLibraryContentTranslations(env, 3, "zh")).toBe(2);
    expect(sends).toEqual([
      { body: { kind: "translate", item_id: 7, lang: "zh" } },
      { body: { kind: "translate", item_id: 8, lang: "zh" } },
    ]);
    sends.length = 0;
    expect(await enqueuePreferredContentTranslation(env, 7)).toBe(1);
    expect(sends).toEqual([{ kind: "translate", item_id: 7, lang: "zh" }]);
  });

  it("does not regenerate a summary that is already Chinese", async () => {
    const sends: unknown[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = {
            bind() { return statement; },
            async all() { return { results: [] }; },
            async first() {
              return sql.includes("AS sample")
                ? { sample: "这是一段已经用中文写好的总结，正文本身就是中文，不需要再生成一版。" }
                : { ok: 1 };
            },
            async run() { return { meta: { changes: 1 } }; },
          };
          return statement;
        },
        async batch() { return []; },
      },
      PIPELINE: {
        async send(message: unknown) { sends.push(message); },
        async sendBatch(messages: unknown[]) { sends.push(...messages); },
      },
    } as unknown as Env;

    expect(await enqueuePreferredContentTranslation(env, 7)).toBe(0);
    expect(sends).toEqual([]);
  });
});
