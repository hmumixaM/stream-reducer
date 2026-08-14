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

import { timelineRoutes } from "./timeline";

function fakeEnv() {
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
          async all() {
            return { results: [] };
          },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, queries };
}

async function timelineQuery(path: string) {
  const app = new Hono<AppContext>();
  app.route("/timeline", timelineRoutes);
  const { env, queries } = fakeEnv();
  const response = await app.request(path, undefined, env);
  expect(response.status).toBe(200);
  return queries[0];
}

describe("timeline route", () => {
  it("deduplicates items shared by several followed channels", async () => {
    const query = await timelineQuery("/timeline");

    expect(query.sql).toContain("JOIN channel_item ci ON ci.channel_id = s.channel_id");
    expect(query.sql).toContain("GROUP BY i.id");
  });

  it("hides paid items and scopes to the caller's follows", async () => {
    const query = await timelineQuery("/timeline");

    expect(query.sql).toContain("i.status != 'excluded'");
    expect(query.sql).toContain("s.user_id = ?");
    // Both the LEFT JOIN and the WHERE clause bind the caller's id.
    expect(query.bindings.slice(0, 2)).toEqual([7, 7]);
  });

  it("defaults to newest published with a stable tiebreaker", async () => {
    const query = await timelineQuery("/timeline");

    expect(query.sql).toContain("ORDER BY i.published_at DESC, i.id DESC");
  });

  it("falls back to the default sort for unknown keys", async () => {
    const query = await timelineQuery("/timeline?sort=nonsense");

    expect(query.sql).toContain("ORDER BY i.published_at DESC, i.id DESC");
  });

  it("filters to unsaved and ready items", async () => {
    const query = await timelineQuery("/timeline?saved=false&ready=true");

    expect(query.sql).toContain("ui.id IS NULL");
    expect(query.sql).toContain("i.status = 'done'");
  });

  it("binds the platform filter after the user ids", async () => {
    const query = await timelineQuery("/timeline?platform=bilibili&limit=10&offset=20");

    expect(query.sql).toContain("i.platform = ?");
    expect(query.bindings).toEqual([7, 7, "bilibili", 10, 20]);
  });

  it("narrows the timeline to a single channel", async () => {
    const query = await timelineQuery("/timeline?channel_id=42&limit=10&offset=0");

    expect(query.sql).toContain("ci.channel_id = ?");
    expect(query.bindings).toEqual([7, 7, 42, 10, 0]);
  });

  it("rejects a channel_id that is not a positive integer", async () => {
    const app = new Hono<AppContext>();
    app.route("/timeline", timelineRoutes);
    const { env } = fakeEnv();

    const response = await app.request("/timeline?channel_id=abc", undefined, env);

    expect(response.status).toBe(400);
  });
});
