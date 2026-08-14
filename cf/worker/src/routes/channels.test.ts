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

function fakeEnv(firstResult: unknown | ((sql: string) => unknown) = null) {
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
            return typeof firstResult === "function"
              ? (firstResult as (sql: string) => unknown)(sql)
              : firstResult;
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

  it("falls back to the default sort when the sort key is unknown", async () => {
    const app = new Hono<AppContext>();
    app.route("/channels", channelRoutes);
    const { env, queries } = fakeEnv({ id: 1 });

    const response = await app.request("/channels/1/items?sort=; DROP TABLE item", undefined, env);

    expect(response.status).toBe(200);
    const itemQuery = queries.find((query) => query.sql.includes("FROM channel_item ci"))!;
    expect(itemQuery.sql).toContain("ORDER BY i.published_at DESC, i.id DESC");
    expect(itemQuery.sql).not.toContain("DROP TABLE");
  });

  it("sorts channel items by discovery time on request", async () => {
    const app = new Hono<AppContext>();
    app.route("/channels", channelRoutes);
    const { env, queries } = fakeEnv({ id: 1 });

    const response = await app.request(
      "/channels/1/items?sort=discovered&order=asc",
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    const itemQuery = queries.find((query) => query.sql.includes("FROM channel_item ci"))!;
    expect(itemQuery.sql).toContain("ORDER BY discovered_at ASC, i.id DESC");
  });

  it("filters channel items to those missing from the library", async () => {
    const app = new Hono<AppContext>();
    app.route("/channels", channelRoutes);
    const { env, queries } = fakeEnv({ id: 1 });

    const response = await app.request("/channels/1/items?saved=false", undefined, env);

    expect(response.status).toBe(200);
    const itemQuery = queries.find((query) => query.sql.includes("FROM channel_item ci"))!;
    expect(itemQuery.sql).toContain("ui.id IS NULL");
    expect(itemQuery.sql).toContain("i.status != 'excluded'");
  });

  it("polls a follow on demand, with no separate auto-update flag to check", async () => {
    const app = new Hono<AppContext>();
    app.route("/subscriptions", subscriptionRoutes);
    const { env, sends } = fakeEnv({ id: 11 });

    const response = await app.request(
      "/subscriptions/11/poll",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    expect(sends).toEqual([{ kind: "poll", subscription_id: 11 }]);
  });

  it("makes every new follow poll, backfilling the default window", async () => {
    const app = new Hono<AppContext>();
    app.route("/channels", channelRoutes);
    let followReads = 0;
    const { env, queries, sends } = fakeEnv((sql: string) => {
      if (sql.includes("FROM channel WHERE id")) {
        return { id: 1, platform: "youtube", feed_url: "https://feed", channel_key: "UC1" };
      }
      if (sql.includes("FROM subscription")) {
        // The route reads the follow before creating it, then again after.
        return followReads++ === 0 ? null : { id: 42, enabled: 1, channel_id: 1 };
      }
      return null;
    });

    const response = await app.request(
      "/channels/1/follow",
      {
        method: "PUT",
        body: "{}",
        headers: { "content-type": "application/json" },
      },
      env,
    );

    expect(response.status).toBe(200);
    const insert = queries.find((query) => query.sql.includes("INSERT OR IGNORE INTO subscription"))!;
    expect(insert.bindings.at(-1)).toBe(1);
    expect(insert.bindings).toContain(60);
    expect(sends).toEqual([{ kind: "poll", subscription_id: 42 }]);
  });
});
