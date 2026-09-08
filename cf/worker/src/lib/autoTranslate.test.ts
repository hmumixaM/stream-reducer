import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { enqueueAutomaticTranslations } from "./autoTranslate";

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
});
