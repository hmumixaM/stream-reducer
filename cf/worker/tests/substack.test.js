import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => ({ fetch: containerFetch }) }));
const containerFetch = vi.fn();
import { Hono } from "hono";
import { database } from "./sqlite.mjs";
import { sha256 } from "../src/lib/crypto";
import { substackRoutes } from "../src/routes/substack";
import { rssRoutes } from "../src/routes/rss";
import { parseSubstack, searchRequest } from "../src/lib/sourceDiscovery";
import { sourceRoutes } from "../src/routes/sources";
import { followRss, persistEntries, pollRss, drainRss } from "../src/lib/rss";
import { openSubstackCookie, sealSubstackCookie, substackCookie, extractSubstackArticle } from "../src/lib/substack";

const states = [];
const publication = { access: "free", provider: "substack", title: "Example newsletter", url: "https://example.substack.com", feed_url: null,
  substack_publication_id: "42", substack_subdomain: "example", image_url: "https://substackcdn.com/logo.png", site_url: "https://example.substack.com" };
const entry = { url: "https://example.substack.com/p/story", title: "Shared story", published_at: "2026-10-18T00:00:00Z", external_id: "123", substack_post_id: "123", content: "A public preview", content_is_full: false };
const fullBody = { text: "A complete subscriber article with sufficient factual detail to generate a useful summary and original source notes.", paragraphs: [{ id: 1, text: "Original source evidence and complete subscriber article." }],
  completeness: "full", method: "substack_api", word_count: 21, source_url: entry.url, canonical_url: entry.url };
async function setup() {
  const s = database(); states.push(s.db);
  s.db.exec("INSERT INTO user(id,email,is_admin,preferred_language) VALUES(1,'admin@example.com',1,'auto'),(2,'reader@example.com',0,'auto'),(3,'other@example.com',0,'auto')");
  for (const id of [1, 2, 3]) s.db.prepare("INSERT INTO session(token_hash,user_id,expires_at) VALUES(?,?,'2099-01-01')").run(await sha256(`session-${id}`), id);
  const objects = new Map();
  const env = { DB: s.DB, SUBSTACK_CREDENTIAL_KEY: "11".repeat(32), RSS_ENABLED: "true", MEDIA: {
    get: vi.fn(async key => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)) } : null),
    put: vi.fn(async (key, value) => { objects.set(key, value); }),
  }, RSS_JOBS: { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) }, LLM_BASE_URL: "https://llm.example", LLM_MODEL: "test", GEMINI_API_KEY: "model-secret" };
  const app = new Hono(); app.route("/api/substack", substackRoutes); app.route("/api/rss", rssRoutes); app.route("/api/sources", sourceRoutes);
  const request = (path, user = 1, method = "GET", body) => app.request(path.startsWith("/api/") ? path : `/api/substack${path}`, {
    method, headers: { ...(user ? { cookie: `sr_session=session-${user}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  containerFetch.mockImplementation(async req => {
    const path = new URL(req.url).pathname;
    const data = path.endsWith("/check") ? { authenticated: true }
      : path.endsWith("/subscriptions") ? { sources: [publication], skipped: 0 }
      : path.endsWith("/resolve") ? publication
      : path.endsWith("/poll") ? { entries: [entry], provider: "substack", next_before: null, next_cursor: null, coverage: "archive_end", warning: null }
      : fullBody;
    return Response.json(data);
  });
  const connect = async (cookie = "substack.sid=secret-session-one", label = "Shared account") => {
    const r = await request("/connections", 1, "POST", { label, cookie });
    expect(r.status).toBe(201); return r.json();
  };
  return { ...s, env, request, connect, objects };
}
afterEach(() => { for (const db of states.splice(0)) db.close(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Substack connections and shared articles", () => {
  it("only discovers explicitly free publications, with public metadata and no credentials", () => {
    const base = { id: 42, subdomain: "example", name: "Free news", payments_state: "disabled", owner_email: "PRIVATE" };
    const rows = parseSubstack({ results: [base, { ...base, id: 43, payments_state: "enabled" }, { ...base, id: 44, payments_state: undefined }, { ...base, id: 45, plans: [{ amount: 500 }] }] });
    expect(parseSubstack({ items: [{ publication: base, context: { users: [{ primary_publication: base }] } }, { publication: { ...base, id: 43, payments_state: "enabled" } }] })).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "substack", access: "free", platform: "substack", kind: "article", feed_url: "https://example.substack.com/feed" });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    expect(searchRequest("substack", "AI & news", "secret")).toEqual({ url: "https://substack.com/api/v1/top/search?query=AI+%26+news&fromSuggestedSearch=false" });
  });
  it("searches free public publications without side effects and follows through the article queue", async () => {
    const s = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [
      { publication: { id: 42, subdomain: "example", name: "Example newsletter", payments_state: "disabled" } },
      { publication: { id: 43, subdomain: "paid", name: "Paid newsletter", payments_state: "enabled" } },
    ] })));
    expect((await s.request("/api/sources/search?provider=substack&q=news", 0)).status).toBe(401);
    const search = await (await s.request("/api/sources/search?provider=substack&q=news&platform=substack", 2)).json();
    expect(search.results).toHaveLength(1);
    expect(search.results[0]).toMatchObject({ provider_id: "42", following: false, access: "free" });
    expect(s.db.prepare("SELECT count(*) n FROM rss_source").get().n).toBe(0);
    expect(s.env.RSS_JOBS.send).not.toHaveBeenCalled();
    const response = await s.request("/api/sources/follow", 2, "POST", { provider: "substack", provider_id: "42", q: "news" });
    expect(response.status).toBe(200);
    expect(s.db.prepare("SELECT provider,substack_access,feed_url FROM rss_source").get()).toMatchObject({ provider: "substack", substack_access: "free", feed_url: "https://example.substack.com/feed" });
    expect(s.env.RSS_JOBS.send).toHaveBeenCalledWith({ kind: "rss_poll", source_id: 1 });
    expect((await (await s.request("/api/sources/search?provider=known&q=news&platform=substack", 2)).json()).results[0].following).toBe(true);
    s.db.exec("UPDATE rss_source SET substack_access='paid'");
    expect((await (await s.request("/api/sources/search?provider=known&q=news&platform=substack", 2)).json()).results).toHaveLength(0);
  });
  it("blocks paid links, directory follows and imports without creating sources or queue jobs", async () => {
    const s = await setup(), c = await s.connect();
    containerFetch.mockImplementation(async req => Response.json(req.url.endsWith("/subscriptions") ? { sources: [{ ...publication, access: "paid" }], skipped: 0 } : { ...publication, access: "paid" }));
    for (const body of [{ publication_id: "42" }, { url: publication.url }]) {
      const response = await s.request(`/connections/${c.id}/follow`, 2, "POST", body);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain("需要付费");
    }
    expect(await (await s.request(`/connections/${c.id}/import`, 2, "POST", {})).json()).toEqual({ imported: 0, skipped: 1 });
    expect(s.db.prepare("SELECT count(*) n FROM rss_source").get().n).toBe(0);
    expect(s.env.RSS_JOBS.send).not.toHaveBeenCalled();
    expect(s.env.RSS_JOBS.sendBatch).not.toHaveBeenCalled();
  });
  it("rechecks saved Substack sources so generic RSS follow cannot bypass payment checks", async () => {
    const s = await setup(), c = await s.connect();
    await s.request(`/connections/${c.id}/import`, 1, "POST", {});
    containerFetch.mockImplementation(async () => Response.json({ ...publication, access: "paid" }));
    for (const path of ["/api/rss/sources/1/follow", "/api/sources/follow"]) {
      const response = await s.request(path, 2, "POST", path.includes("sources/follow") ? { provider: "known", rss_source_id: 1 } : {});
      expect(response.status).toBe(403);
    }
    expect(s.db.prepare("SELECT count(*) n FROM rss_follow WHERE user_id=2").get().n).toBe(0);
  });
  it("encrypts credentials, authenticates ciphertext to the connection, and only accepts session cookies", async () => {
    const s = await setup();
    expect(substackCookie("tracking=no; substack.sid=session; email=private; connect.sid=other")).toBe("substack.sid=session; connect.sid=other");
    expect(() => substackCookie("substack.sid=x\r\nInjected: yes")).toThrow();
    expect(() => substackCookie("email=private")).toThrow();
    const credentials = await sealSubstackCookie(s.env, "one", "substack.sid=secret");
    expect(credentials).not.toContain("secret");
    expect(await openSubstackCookie(s.env, { id: "one", credentials })).toBe("substack.sid=secret");
    await expect(openSubstackCookie(s.env, { id: "two", credentials })).rejects.toThrow("凭据不可用");
  });
  it("restricts credential management to admins but exposes every shared connection without credentials", async () => {
    const s = await setup();
    expect((await s.request("/connections", 0)).status).toBe(401);
    expect((await s.request("/connections", 2, "POST", { label: "x", cookie: "substack.sid=leaked" })).status).toBe(403);
    const a = await s.connect(), b = await s.connect("connect.sid=second-secret", "Second account");
    const listed = await (await s.request("/connections", 2)).json();
    expect(listed.map(x => x.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(JSON.stringify(listed)).not.toMatch(/secret|credentials|email/);
    const stored = s.db.prepare("SELECT * FROM substack_connection WHERE id=?").get(a.id);
    expect(stored.credentials).not.toContain("secret-session-one");
    expect((await s.request(`/connections/${a.id}`, 2, "PATCH", { enabled: false })).status).toBe(403);
  });
  it("does not persist an invalid connection and never exposes raw upstream credential errors", async () => {
    const s = await setup();
    containerFetch.mockResolvedValue(Response.json({ detail: "SUBSTACK_AUTH" }, { status: 401 }));
    expect((await s.request("/connections", 1, "POST", { label: "broken", cookie: "substack.sid=wrong" })).status).toBe(422);
    expect(s.db.prepare("SELECT count(*) n FROM substack_connection").get().n).toBe(0);
  });
  it("allows any user to import a shared account's subscriptions and keeps personal follows independent", async () => {
    const s = await setup(), c = await s.connect();
    const path = `/connections/${c.id}`;
    const preview = await (await s.request(`${path}/subscriptions`, 2)).json();
    expect(preview.sources[0].following).toBe(false);
    expect((await s.request(`${path}/import`, 2, "POST", {})).status).toBe(200);
    expect((await s.request(`${path}/import`, 2, "POST", {})).status).toBe(200);
    expect(s.db.prepare("SELECT count(*) n FROM rss_source").get().n).toBe(1);
    expect(s.db.prepare("SELECT count(*) n FROM rss_follow WHERE user_id=1").get().n).toBe(0);
    expect(s.db.prepare("SELECT count(*) n FROM rss_follow WHERE user_id=2").get().n).toBe(1);
    expect((await (await s.request(`${path}/subscriptions`, 2)).json()).sources[0].following).toBe(true);
    const catalog = await (await s.request("/api/rss/catalog", 3)).json();
    expect(catalog).toHaveLength(1);
    expect(JSON.stringify(catalog)).not.toContain("secret-session-one");
    expect((await s.request(`/api/rss/sources/${catalog[0].id}/follow`, 3, "POST", {})).status).toBe(201);
    expect(s.db.prepare("SELECT count(*) n FROM rss_follow").get().n).toBe(2);
  });
  it("supports direct publication links and rejects forged directory IDs", async () => {
    const s = await setup(), c = await s.connect();
    expect((await s.request(`/connections/${c.id}/follow`, 2, "POST", { publication_id: "999", cookie: "injected" })).status).toBe(404);
    const r = await s.request(`/connections/${c.id}/follow`, 2, "POST", { url: "https://example.substack.com" });
    expect(r.status).toBe(201);
    expect(s.db.prepare("SELECT substack_connection_id,substack_subdomain FROM rss_source").get()).toMatchObject({ substack_connection_id: c.id, substack_subdomain: "example" });
    expect(containerFetch.mock.calls.every(([req]) => req.method === "POST")).toBe(true); // Internal RPC only; Python enforces upstream GETs.
  });
  it("deduplicates posts globally across connections and shares the cached full body with other followers", async () => {
    const s = await setup(), c1 = await s.connect(), c2 = await s.connect("substack.sid=second-session", "Second account");
    for (const [c, user] of [[c1, 1], [c2, 2]]) await s.request(`/connections/${c.id}/import`, user, "POST", {});
    for (const row of s.db.prepare("SELECT * FROM rss_source").all()) await persistEntries(s.env, row, [entry]);
    expect(s.db.prepare("SELECT count(*) n FROM rss_article").get().n).toBe(1);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ level: "article", reason: "article", headline: "Shared facts", intro: "Overview", points: ["One fact"], sections: [], summary_covered: true }) } }] })));
    await drainRss(s.env);
    expect(s.db.prepare("SELECT completeness,status FROM rss_article").get()).toMatchObject({ completeness: "full", status: "done" });
    const readerBody = await (await s.request("/api/rss/articles/1/body", 2)).json();
    expect(readerBody.text).toBe(fullBody.text);
    const extractionCount = containerFetch.mock.calls.filter(([r]) => r.url.endsWith("/substack/extract")).length;
    await drainRss(s.env);
    expect(containerFetch.mock.calls.filter(([r]) => r.url.endsWith("/substack/extract"))).toHaveLength(extractionCount);
    expect(JSON.stringify([...s.objects.values()])).not.toMatch(/secret-session|second-session|credentials/);
  });
  it("tries another connection when the first can only read a preview", async () => {
    const s = await setup(), a = await s.connect(), b = await s.connect("substack.sid=paid-session", "Paid account");
    for (const c of [a, b]) await s.request(`/connections/${c.id}/import`, 1, "POST", {});
    for (const row of s.db.prepare("SELECT * FROM rss_source").all()) await persistEntries(s.env, row, [entry]);
    containerFetch.mockImplementation(async req => {
      const d = await req.json();
      return Response.json(d.cookie.includes("paid-session") ? fullBody : { ...fullBody, text: "Preview", completeness: "partial", word_count: 1 });
    });
    expect((await extractSubstackArticle(s.env, 1, "123")).completeness).toBe("full");
  });
  it("persists archive offsets, including pages sharing the same timestamp", async () => {
    const s = await setup(), c = await s.connect();
    await s.request(`/connections/${c.id}/import`, 1, "POST", {});
    containerFetch.mockImplementation(async req => {
      if (!req.url.endsWith("/substack/poll")) return Response.json({ image_url: null, site_url: publication.url });
      const d = await req.json();
      return Response.json({ entries: [entry], provider: "substack", next_before: "2026-10-18T00:00:00Z", next_cursor: String(Number(d.cursor || 0) + 50), coverage: "available", warning: null });
    });
    await pollRss(s.env, 1); await pollRss(s.env, 1, true);
    expect(s.db.prepare("SELECT backfill_cursor,backfill_status FROM rss_source").get()).toMatchObject({ backfill_cursor: "100", backfill_status: "running" });
    expect(s.db.prepare("SELECT count(*) n FROM rss_article").get().n).toBe(1);
  });
  it("pauses invalid sessions, preserves stored articles, and permits replacing credentials", async () => {
    const s = await setup(), c = await s.connect();
    await s.request(`/connections/${c.id}/import`, 1, "POST", {});
    containerFetch.mockImplementation(async () => Response.json({ detail: "SUBSTACK_AUTH" }, { status: 401 }));
    await pollRss(s.env, 1);
    expect(s.db.prepare("SELECT status FROM substack_connection").get().status).toBe("needs_auth");
    expect(s.db.prepare("SELECT auth_error FROM rss_source").get().auth_error).toBe(1);
    expect((await s.request(`/connections/${c.id}/import`, 2, "POST", {})).status).toBe(422);
    containerFetch.mockImplementation(async () => Response.json({ authenticated: true }));
    expect((await s.request(`/connections/${c.id}`, 1, "PATCH", { cookie: "substack.sid=renewed" })).status).toBe(200);
    const row = s.db.prepare("SELECT * FROM substack_connection").get();
    expect(row.status).toBe("active"); expect(await openSubstackCookie(s.env, row)).toBe("substack.sid=renewed");
    expect(s.db.prepare("SELECT auth_error FROM rss_source").get().auth_error).toBe(0);
    await s.request(`/connections/${c.id}`, 1, "PATCH", { enabled: false });
    expect((await s.request(`/connections/${c.id}/import`, 2, "POST", {})).status).toBe(422);
  });
  it("keeps container capacity failures retryable without spending source or article attempts", async () => {
    const s = await setup(), c = await s.connect();
    await s.request(`/connections/${c.id}/import`, 1, "POST", {});
    const source = s.db.prepare("SELECT * FROM rss_source").get();
    await persistEntries(s.env, source, [entry]);
    containerFetch.mockRejectedValue(new Error("There is no container instance that can be provided to this Durable Object, try again later"));
    await pollRss(s.env, source.id); await drainRss(s.env);
    expect(s.db.prepare("SELECT status,attempts FROM rss_article").get()).toMatchObject({ status: "queued", attempts: 0 });
    expect(s.db.prepare("SELECT failures FROM rss_source").get().failures).toBe(0);
    expect(s.db.prepare("SELECT status FROM substack_connection").get().status).toBe("active");
  });
});
