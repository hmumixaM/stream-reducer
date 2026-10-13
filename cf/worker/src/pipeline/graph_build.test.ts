import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { buildGraph } from "./graph_build";

function fakeEnv(rowCount: number) {
  const prunes: unknown[][] = [];
  let pruneCalls = 0;
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: 10_000 - i,
    item_id: i,
    field: "overview",
    text: "paragraph",
    embedding: "[0,0]",
  }));
  const DB = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bindings = values; return statement; },
        async all() { return { results: sql.includes("FROM chunk") ? rows : [] }; },
        async first() { return { fingerprint: `${rows.length}:${rows[0]?.id ?? 0}:${rows[rows.length - 1]?.id ?? 0}` }; },
        async run() {
          if (sql.includes("SET embedding = NULL")) {
            prunes.push(bindings);
            return { meta: { changes: pruneCalls++ === 0 ? 1000 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  return { env: { DB } as unknown as Env, prunes };
}

describe("graph build embedding retention", () => {
  it("drops vectors older than the graph window until none remain", async () => {
    const { env, prunes } = fakeEnv(4000);

    await buildGraph(env, false);

    expect(prunes).toEqual([[6001], [6001]]);
  });

  it("keeps every vector while the window is not full", async () => {
    const { env, prunes } = fakeEnv(10);

    await buildGraph(env, false);

    expect(prunes).toEqual([]);
  });
});
