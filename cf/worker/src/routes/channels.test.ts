import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";

vi.mock("../auth", () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", {
      id: 7,
      email: "user@example.com",
      is_admin: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await next();
  },
}));

import { channelRoutes } from "./channels";
import { subscriptionRoutes } from "./subscriptions";

function fakeEnv(firstResult: unknown = null) {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  const sends: unknown[] = [];
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
    PIPELINE: {
      async send(message: unknown) {
        sends.push(message);
      },
    },
  } as unknown as Env;
  return { env, queries, sends };
}

describe("channel route safeguards", () => {
  it("excludes paid items from channel item responses", async () => {
    const app = new Hono<AppContext>();
    app.route("/channels", channelRoutes);
    const { env, queries } = fakeEnv({ id: 1 });

    const response = await app.request("/channels/1/items", undefined, env);

    expect(response.status).toBe(200);
    expect(
      queries.some((query) =>
        query.sql.includes("WHERE ci.channel_id = ? AND i.status != 'excluded'"),
      ),
    ).toBe(true);
  });

  it("excludes paid items from channel counts and previews", async () => {
    const app = new Hono<AppContext>();
    app.route("/channels", channelRoutes);
    const { env, queries } = fakeEnv();

    const response = await app.request("/channels", undefined, env);

    expect(response.status).toBe(200);
    expect(queries[0].sql).toContain("count_item.status != 'excluded'");
    expect(queries[0].sql).toContain("i.status != 'excluded'");
  });

  it("rejects legacy manual polls when follow-latest is disabled", async () => {
    const app = new Hono<AppContext>();
    app.route("/subscriptions", subscriptionRoutes);
    const { env, queries, sends } = fakeEnv({ id: 11, enabled: 0 });

    const response = await app.request(
      "/subscriptions/11/poll",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(400);
    expect(queries[0].sql).toContain("SELECT id, enabled");
    expect(sends).toEqual([]);
  });
});
