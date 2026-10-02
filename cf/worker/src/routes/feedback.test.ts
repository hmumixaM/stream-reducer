import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";

vi.mock("../auth", () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: 7, email: "reader@example.com", is_admin: 0, created_at: "2026-01-01T00:00:00.000Z" });
    await next();
  },
}));

import { feedbackAdminRoutes, feedbackRoutes } from "./feedback";

interface Query { sql: string; bindings: unknown[] }

function fakeEnv() {
  const queries: Query[] = [];
  const objects = new Map<string, { body: ArrayBuffer; type: string }>();
  const env = {
    DB: {
      prepare(sql: string) {
        const query: Query = { sql, bindings: [] };
        queries.push(query);
        const statement = {
          bind(...bindings: unknown[]) {
            query.bindings = bindings;
            return statement;
          },
          async first() {
            if (sql.includes("FROM feedback_image WHERE id")) {
              const stored = [...objects.keys()][0];
              return stored ? { image_key: stored, mime_type: "image/png" } : null;
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM feedback ORDER BY")) {
              return { results: [{ id: 41, email: "reader@example.com", kind: "bug", body: "Diagram broke", page_url: "https://reducer.xgoose.org/bulletin/4003", created_at: "2026-10-02T00:00:00.000Z" }] };
            }
            if (sql.includes("FROM feedback_image WHERE feedback_id IN")) {
              return { results: [{ id: 3, feedback_id: 41 }] };
            }
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 1, last_row_id: 41 } };
          },
        };
        return statement;
      },
    },
    MEDIA: {
      async put(key: string, body: ArrayBuffer, options: { httpMetadata: { contentType: string } }) {
        objects.set(key, { body, type: options.httpMetadata.contentType });
      },
      async get(key: string) {
        const stored = objects.get(key);
        if (!stored) return null;
        return {
          body: stored.body,
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", stored.type);
          },
        };
      },
    },
  } as unknown as Env;
  return { env, queries, objects };
}

function app() {
  const instance = new Hono<AppContext>();
  instance.route("/feedback", feedbackRoutes);
  instance.route("/admin", feedbackAdminRoutes);
  return instance;
}

describe("feedback", () => {
  it("records the signed-in email with a bug report", async () => {
    const { env, queries } = fakeEnv();
    const form = new FormData();
    form.set("kind", "bug");
    form.set("body", "  The diagram shows a syntax error  ");
    form.set("page_url", "https://reducer.xgoose.org/bulletin/4003?view=notes");

    const response = await app().request("/feedback", { method: "POST", body: form }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 41, email: "reader@example.com" });
    const insert = queries.find((query) => query.sql.includes("INSERT INTO feedback "));
    expect(insert?.bindings.slice(0, 5)).toEqual([
      7,
      "reader@example.com",
      "bug",
      "The diagram shows a syntax error",
      "https://reducer.xgoose.org/bulletin/4003?view=notes",
    ]);
  });

  it("rejects an empty note before writing", async () => {
    const { env, queries } = fakeEnv();
    const form = new FormData();
    form.set("kind", "suggestion");
    form.set("body", "   ");
    const response = await app().request("/feedback", { method: "POST", body: form }, env);
    expect(response.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("stores an uploaded image privately in R2", async () => {
    const { env, queries, objects } = fakeEnv();
    const form = new FormData();
    form.set("kind", "suggestion");
    form.set("body", "Please add a darker chart");
    form.append("images", new File([Uint8Array.from([1, 2, 3])], "chart.png", { type: "image/png" }));

    const response = await app().request("/feedback", { method: "POST", body: form }, env);
    expect(response.status).toBe(200);
    expect([...objects.keys()][0]).toMatch(/^feedback\/41\/.+\.png$/);
    expect(queries.some((query) => query.sql.includes("INSERT INTO feedback_image"))).toBe(true);
  });

  it("lists reports for an admin with their image ids", async () => {
    const { env } = fakeEnv();
    const response = await app().request("/admin/feedback", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      id: 41,
      email: "reader@example.com",
      kind: "bug",
      body: "Diagram broke",
      page_url: "https://reducer.xgoose.org/bulletin/4003",
      created_at: "2026-10-02T00:00:00.000Z",
      image_ids: [3],
    }]);
  });
});
