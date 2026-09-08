import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { enqueueAutomaticInfographic } from "./autoInfographic";

function testEnv(options: {
  itemReady: boolean;
  translationStatus?: string;
}): { env: Env; sends: unknown[] } {
  const sends: unknown[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (sql.includes("FROM item i")) {
              return options.itemReady ? { id: 42 } : null;
            }
            if (sql.includes("c.auto_infographic")) return { id: 7 };
            return null;
          },
          async all() {
            if (sql.includes("c.auto_infographic")) {
              return { results: [{ auto_translate_langs: '["zh"]' }] };
            }
            if (sql.includes("FROM item_translation")) {
              return {
                results: options.translationStatus
                  ? [{ lang: "zh", status: options.translationStatus }]
                  : [],
              };
            }
            return { results: [] };
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
  return { env, sends };
}

describe("automatic collection infographics", () => {
  it("does not generate before the source summary succeeds", async () => {
    const { env, sends } = testEnv({ itemReady: false });

    expect(await enqueueAutomaticInfographic(env, 42)).toBe(false);
    expect(sends).toEqual([]);
  });

  it("waits for required collection translations", async () => {
    const { env, sends } = testEnv({
      itemReady: true,
      translationStatus: "processing",
    });

    expect(await enqueueAutomaticInfographic(env, 42)).toBe(false);
    expect(sends).toEqual([]);
  });

  it("queues the final step after all content is done", async () => {
    const { env, sends } = testEnv({
      itemReady: true,
      translationStatus: "done",
    });

    expect(await enqueueAutomaticInfographic(env, 42)).toBe(true);
    expect(sends).toEqual([{ kind: "infographic", item_id: 42 }]);
  });
});
