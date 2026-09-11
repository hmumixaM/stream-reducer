import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";

vi.mock("../auth", () => ({
  resolveUser: async () => null,
}));

import { collectionRoutes } from "./collections";

describe("public collection routes", () => {
  it("lists collections without requiring a session", async () => {
    const app = new Hono<AppContext>();
    app.route("/collections", collectionRoutes);
    const { env } = queryRecordingEnv();

    const response = await app.request("/collections", undefined, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("keeps track order stable and excludes gated items", async () => {
    const app = new Hono<AppContext>();
    app.route("/collections", collectionRoutes);
    const { env, queries } = queryRecordingEnv({ id: 4 });

    const response = await app.request(
      "/collections/example/tracks/4/items?limit=20&offset=40",
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    const itemQuery = queries.find((query) =>
      query.sql.includes("FROM collection_track_item cti"),
    )!;
    expect(itemQuery.sql).toContain("i.status != 'excluded'");
    expect(itemQuery.sql).toContain("ORDER BY cti.position, i.id");
    expect(itemQuery.bindings.slice(-2)).toEqual([20, 40]);
  });
});

function queryRecordingEnv(firstResult: unknown = null) {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const query = { sql, bindings: [] as unknown[] };
        queries.push(query);
        const statement = {
          bind(...bindings: unknown[]) {
            query.bindings = bindings;
            return statement;
          },
          async first() {
            return firstResult;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { success: true };
          },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, queries };
}
