import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";
vi.mock("../auth", () => ({ requireAuth: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => { c.set("user", { id: 4, preferred_language: "zh" }); await next(); } }));
import { bulletinRoutes, parsePoints, serializeBulletin } from "./bulletin";
const row = { id: 10, title: "Original", headline: null, subhead: null, author: "Publisher", source_url: "https://example.com", platform: "youtube", duration_s: 600, published_at: "2026-09-18T13:00:00Z", created_at: "2026-09-18T14:00:00Z", sort_date: 2461302.1, saved: 1, summary_structured: JSON.stringify({ bulletin: [{ text: "Source claim", timestamp: 90 }], tldr: "Original overview", walkthrough: "Long original content" }), summary_markdown: "Long Markdown", localized_bulletin: JSON.stringify([{ text: "中文要点", timestamp: 90 }]), localized_bulletin_status: "done" };
function setup(rows: unknown[] = [], detail: unknown = null) {
  const queries: { sql: string; args: unknown[] }[] = [];
  const env = { DB: { prepare(sql: string) { const query = { sql, args: [] as unknown[] }; queries.push(query); return { bind(...args: unknown[]) { query.args = args; return this; }, async all() { return { results: rows }; }, async first() { return detail; } }; } } } as unknown as Env;
  const app = new Hono<AppContext>(); app.route("/api/bulletin", bulletinRoutes);
  return { app, env, queries };
}
describe("bulletin reading API", () => {
  it("uses Chinese bulletin with intact timestamps without rewriting the original detail", () => {
    const card = serializeBulletin(row, "zh");
    expect(card.bulletin_points).toEqual([{ text: "中文要点", timestamp: 90 }]);
    expect(card).not.toHaveProperty("walkthrough");
    expect(card).not.toHaveProperty("markdown");
    const detail = serializeBulletin(row, "zh", true);
    expect(detail).toHaveProperty("walkthrough", "Long original content");
    expect(detail).toHaveProperty("tldr", "Original overview");
  });
  it("falls back honestly when a localized result is empty or broken", () => {
    expect(serializeBulletin({ ...row, localized_bulletin: "broken" }, "zh").bulletin_language).toBe("original");
    expect(serializeBulletin({ ...row, localized_bulletin: "broken" }, "zh").localization_status).toBe("error");
    expect(serializeBulletin({ ...row, localized_bulletin: "[]" }, "zh").bulletin).toEqual(["Source claim"]);
    expect(parsePoints(["Legacy", { text: "Bad timestamp", timestamp: -1 }])).toEqual([{ text: "Legacy", timestamp: null }, { text: "Bad timestamp", timestamp: null }]);
  });
  it("keeps the feed lightweight and emits a stable cursor for older pages", async () => {
    const { app, env, queries } = setup([row, { ...row, id: 9 }]);
    const response = await app.request("/api/bulletin/feed?limit=1", {}, env);
    const data = await response.json() as { items: unknown[]; next_cursor: string };
    expect(data.items).toHaveLength(1);
    expect(JSON.parse(atob(data.next_cursor))).toEqual([row.sort_date, 10]);
    expect(queries[0].sql).not.toContain("s.markdown");
    expect(queries[0].sql).not.toContain("$.walkthrough");
    expect(queries[0].args.slice(0, 3)).toEqual([4, 4, 4]);
  });
  it("binds filters and cursor while retaining user access restrictions", async () => {
    const { app, env, queries } = setup();
    const cursor = encodeURIComponent(btoa(JSON.stringify([2461302.1, 10])));
    expect((await app.request(`/api/bulletin/feed?cursor=${cursor}&q=test&platform=youtube&saved=true`, {}, env)).status).toBe(200);
    expect(queries[0].args).toEqual([4, 4, 4, 2461302.1, 2461302.1, 10, "%test%", "%test%", "%test%", "youtube", 25, 0]);
    expect(queries[0].sql).toContain("sub.enabled=1");
  });
  it.each(["/feed?limit=bad", "/feed?cursor=bad", "/nope", "/0/reading-summary"])("rejects invalid input before a query: %s", async (url) => {
    const { app, env, queries } = setup();
    const response = await app.request(`/api/bulletin${url}`, { method: url.endsWith("reading-summary") ? "POST" : "GET" }, env);
    expect(response.status).toBe(400);
    expect(queries).toHaveLength(0);
  });
  it("does not generate a brief for an inaccessible source", async () => {
    const { app, env } = setup();
    expect((await app.request("/api/bulletin/99/reading-summary", { method: "POST" }, env)).status).toBe(404);
  });
});
