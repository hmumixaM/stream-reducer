import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";

vi.mock("../auth", () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: 7, email: "user@example.com", is_admin: 0, created_at: "2026-01-01T00:00:00.000Z" });
    await next();
  },
}));

import { researchRoutes } from "./research";

type Query = { sql: string; bindings: unknown[] };

function fakeEnv(options: { first?: unknown; all?: unknown[]; lastRowId?: number } = {}) {
  const queries: Query[] = [];
  const env = {
    LLM_BASE_URL: "",
    GEMINI_API_KEY: "",
    DB: {
      prepare(sql: string) {
        const query: Query = { sql, bindings: [] };
        queries.push(query);
        const statement = {
          bind(...bindings: unknown[]) {
            query.bindings = bindings;
            return statement;
          },
          async first() { return options.first ?? null; },
          async all() { return { results: options.all ?? [] }; },
          async run() { return { meta: { changes: 1, last_row_id: options.lastRowId ?? 11 } }; },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, queries };
}

function app() {
  const instance = new Hono<AppContext>();
  instance.route("/research", researchRoutes);
  return instance;
}

describe("research routes", () => {
  it("scopes on-demand questions to the user's saved or followed summaries", async () => {
    const { env, queries } = fakeEnv();
    const response = await app().request("/research/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What changed?" }),
    }, env);

    expect(response.status).toBe(200);
    const itemQuery = queries.find((query) => query.sql.includes("FROM item i"));
    expect(itemQuery?.sql).toContain("JOIN summary s ON s.item_id = i.id");
    expect(itemQuery?.sql).toContain("ui.user_id = ?");
    expect(itemQuery?.sql).toContain("sub.user_id = ?");
    expect(itemQuery?.bindings).toEqual([7, 7]);
    expect(queries.some((query) => query.sql.includes("INSERT INTO research_ask"))).toBe(true);
  });

  it("rejects empty questions before touching the database", async () => {
    const { env, queries } = fakeEnv();
    const response = await app().request("/research/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "  " }),
    }, env);

    expect(response.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("only schedules research for users with coverage or enabled agents", async () => {
    const { env, queries } = fakeEnv({ all: [] });
    const { generateResearchForAllUsers } = await import("./research");
    expect(await generateResearchForAllUsers(env)).toBe(0);
    expect(queries[0].sql).toContain("FROM research_coverage");
    expect(queries[0].sql).toContain("FROM research_agent WHERE enabled = 1");
    expect(queries).toHaveLength(1);
  });
});
