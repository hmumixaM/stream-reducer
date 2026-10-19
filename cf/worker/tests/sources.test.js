import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { database } from "./sqlite.mjs";
const { containerFetch } = vi.hoisted(() => ({ containerFetch: vi.fn() }));
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => ({ fetch: containerFetch }) }));
vi.mock("../src/auth", () => ({
  resolveUser: async (_env, c) => c.req.header("x-user") ? { id: Number(c.req.header("x-user")), email: "reader@example.com" } : null,
  requireAuth: async (c, next) => { if (!c.req.header("x-user")) return c.json({ error: "unauthorized" }, 401); c.set("user", { id: Number(c.req.header("x-user")) }); await next(); },
}));
import { sourceRoutes } from "../src/routes/sources";
import { parseYoutube, parseBilibili, parseApple, parseFolo, discoverSources } from "../src/lib/sourceDiscovery";
const states = [];
function setup() {
  const state = database(); states.push(state.db);
  state.db.exec("INSERT INTO user(id,email) VALUES(1,'one@example.com'),(2,'two@example.com')");
  const app = new Hono(); app.route("/sources", sourceRoutes);
  const env = { DB: state.DB, PIPELINE: { send: vi.fn(async () => {}) }, RSS_JOBS: { send: vi.fn(async () => {}) }, FOLO_TOKEN: "server-only-secret", SUBSCRIPTION_WINDOW_DAYS: "60", RSS_CONTAINER: {} };
  const request = (url, body, user = 1) => app.request(`/sources${url}`, { method: body ? "POST" : "GET", headers: { ...(user ? { "x-user": String(user) } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
  return { ...state, env, request };
}
const bili = { code: 0, data: { result: [{ mid: 123, uname: "Example UP", upic: "//i.example.com/avatar.jpg", usign: "A public description" }] } };
const article = { id: "555", title: "Public news", url: "https://example.com/feed", siteUrl: "https://example.com", image: "https://example.com/icon.png" };
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => Response.json(bili))); containerFetch.mockReset(); });
afterEach(() => { states.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("source discovery parsers", () => {
  it("extracts channels only, with quoted braces and nested YouTube renderers", () => {
    const id = "UC1234567890123456789012";
    const data = { contents: [{ videoRenderer: { channelId: id } }, { channelRenderer: { channelId: id, title: { simpleText: 'A {channel} "name"' }, descriptionSnippet: { runs: [{ text: "About" }] } } }] };
    const rows = parseYoutube(`before var ytInitialData = ${JSON.stringify(data)}; after`);
    expect(rows).toHaveLength(1); expect(rows[0].title).toBe('A {channel} "name"'); expect(rows[0].aliases).toContain(`youtube:${id}`);
    expect(() => parseYoutube("Consent required")).toThrow();
  });
  it("rejects blocked Bilibili replies, normalizes images, and only returns Apple shows with feeds", () => {
    expect(() => parseBilibili({ code: -412 })).toThrow();
    expect(parseBilibili(bili)[0].image_url).toBe("https://i.example.com/avatar.jpg");
    expect(parseApple({ results: [{ kind: "podcast", collectionId: 3, collectionName: "Show", feedUrl: "https://example.com/podcast" }, { kind: "podcast", collectionId: 4 }, { kind: "song" }] })).toHaveLength(1);
  });
  it("whitelists public Folo metadata and recognizes Xiaoyuzhou RSSHub identities", () => {
    const pid = "123456789012345678901234";
    const rows = parseFolo({ data: [{ feed: { ...article, owner: { email: "private" } }, subscription: { category: "secret" } },
      { feed: { ...article, id: "556", isPrivate: true } },
      { feed: { ...article, id: "557", url: `rsshub://xiaoyuzhou/podcast/${pid}` } }] }, {});
    expect(rows).toHaveLength(2); expect(rows[1].kind).toBe("media"); expect(rows[1].platform).toBe("xiaoyuzhou");
    expect(rows[1].url).toBe(`https://www.xiaoyuzhoufm.com/podcast/${pid}`);
    expect(JSON.stringify(rows)).not.toMatch(/private|secret|owner|category/);
  });
});

describe("unified source search and follow", () => {
  it("keeps anonymous discovery public for channels and requires login for external/RSS", async () => {
    const { request, db } = setup();
    db.exec("INSERT INTO channel(platform,channel_key,key_kind,feed_url,title) VALUES('rss','https://a.example/feed','feed_url','https://a.example/feed','Public channel')");
    db.exec("INSERT INTO rss_source(identity,provider,url,title,backfill_since) VALUES('feed:https://b.example','rss','https://b.example','Article source','2026-01-01')");
    const result = await (await request("/search?provider=known", null, 0)).json();
    expect(result.results).toHaveLength(1); expect(result.results[0].following).toBe(false);
    expect((await request("/search?provider=folo&q=news", null, 0)).status).toBe(401);
    expect((await request("/follow", { provider: "known", channel_id: 1 }, 0)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("classifies legacy Apple RSS before filtering and paginates combined catalogs", async () => {
    const { request, db } = setup();
    db.exec("INSERT INTO channel(platform,channel_key,key_kind,feed_url,source_url,title) VALUES('rss','https://example.com/podcast','feed_url','https://example.com/podcast','https://podcasts.apple.com/podcast/id123','Podcast')");
    db.exec("INSERT INTO rss_source(identity,provider,url,title,backfill_since) VALUES('feed:https://news.example','rss','https://news.example','News','2026-01-01')");
    const apple = await (await request("/search?platform=apple_podcast")).json();
    expect(apple.results).toHaveLength(1); expect(apple.results[0].platform).toBe("apple_podcast");
    const page1 = await (await request("/search?limit=1")).json();
    expect(page1.next_offset).toBe(1);
    const page2 = await (await request("/search?limit=1&offset=1")).json();
    expect(page2.next_offset).toBeNull(); expect(page2.results[0].key).not.toBe(page1.results[0].key);
  });
  it("hydrates only the current user's follows without mutating during search", async () => {
    const { request, db, env } = setup();
    db.exec("INSERT INTO channel(id,platform,channel_key,key_kind,feed_url,title) VALUES(1,'bilibili','123','provider_id','https://space.bilibili.com/123','Known')");
    db.exec("INSERT INTO subscription(user_id,channel_id,platform,feed_url) VALUES(2,1,'bilibili','https://space.bilibili.com/123')");
    const before = db.prepare("SELECT count(*) n FROM channel").get().n;
    const one = await (await request("/search?provider=bilibili&q=Example")).json();
    const two = await (await request("/search?provider=bilibili&q=Example", null, 2)).json();
    expect(one.results[0].following).toBe(false); expect(two.results[0].following).toBe(true);
    expect(one.results[0].channel_id).toBe(1); expect(db.prepare("SELECT count(*) n FROM channel").get().n).toBe(before);
    expect(env.PIPELINE.send).not.toHaveBeenCalled(); expect(env.RSS_JOBS.send).not.toHaveBeenCalled();
  });
  it("revalidates external selections, ignores forged metadata, and retries a failed first queue send", async () => {
    const { request, db, env } = setup();
    env.PIPELINE.send.mockRejectedValueOnce(new Error("queue down"));
    const payload = { provider: "bilibili", provider_id: "123", q: "Example", title: "Forged", feed_url: "http://localhost/" };
    expect((await request("/follow", payload)).status).toBe(502);
    expect((await request("/follow", payload)).status).toBe(200);
    expect((await request("/follow", payload)).status).toBe(200);
    expect(db.prepare("SELECT count(*) n FROM subscription").get().n).toBe(1);
    expect(db.prepare("SELECT title FROM channel").get().title).toBe("Example UP");
    expect(env.PIPELINE.send).toHaveBeenCalledTimes(2);
    expect((await request("/follow", { ...payload, provider_id: "999" })).status).toBe(409);
  });
  it("routes Folo podcast inspection to media rather than articles", async () => {
    const { request, db, env } = setup();
    fetch.mockImplementation(async () => Response.json({ data: [{ feed: article }] }));
    containerFetch.mockResolvedValue(Response.json({ identity: "feed:https://example.com/feed", provider: "folo", feed_url: "https://example.com/feed", url: "https://app.folo.is/feed/555", folo_id: "555", title: "Public news", kind: "media" }));
    expect((await request("/follow", { provider: "folo", provider_id: "555", q: "news" })).status).toBe(200);
    expect(db.prepare("SELECT count(*) n FROM subscription").get().n).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM rss_follow").get().n).toBe(0);
    expect(env.PIPELINE.send).toHaveBeenCalledTimes(1);
  });
  it("follows public Folo articles only in reducer and recovers RSS queue failure", async () => {
    const { request, db, env } = setup();
    fetch.mockImplementation(async () => Response.json({ data: [{ feed: article }] }));
    containerFetch.mockImplementation(async () => Response.json({ identity: "feed:https://example.com/feed", provider: "folo", feed_url: "https://example.com/feed", url: "https://app.folo.is/feed/555", folo_id: "555", title: "Public news", kind: "article" }));
    env.RSS_JOBS.send.mockRejectedValueOnce(new Error("queue down"));
    const payload = { provider: "folo", provider_id: "555", q: "news" };
    expect((await request("/follow", payload)).status).toBe(502);
    expect((await request("/follow", payload)).status).toBe(200);
    expect(db.prepare("SELECT count(*) n FROM rss_follow").get().n).toBe(1);
    expect(env.PIPELINE.send).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/discover"))).toBe(true);
  });
  it("bounds a blocked upstream and uses only a fixed container search operation", async () => {
    const { env } = setup();
    fetch.mockRejectedValue(new Error("blocked"));
    containerFetch.mockImplementation(async request => { expect(new URL(request.url).pathname).toBe("/source-search"); const body = await request.json(); expect(body).toEqual({ provider: "bilibili", q: "test", token: "" }); return Response.json({ body: JSON.stringify(bili) }); });
    expect(await discoverSources(env, "bilibili", "test")).toHaveLength(1);
  });
});

describe("source search resilience", () => {
  it("caches only public descriptors and hydrates follow state after each cache hit", async () => {
    const { request, db } = setup();
    const cache = new Map();
    vi.stubGlobal("caches", { default: { match: async key => cache.get(key.url)?.clone(), put: async (key, response) => cache.set(key.url, response.clone()) } });
    const first = await (await request("/search?provider=bilibili&q=cached")).json();
    db.exec("INSERT INTO channel(id,platform,channel_key,key_kind,feed_url,title) VALUES(1,'bilibili','123','provider_id','https://space.bilibili.com/123','Known'); INSERT INTO subscription(user_id,channel_id,feed_url) VALUES(2,1,'https://space.bilibili.com/123')");
    const second = await (await request("/search?provider=bilibili&q=cached", null, 2)).json();
    expect(fetch).toHaveBeenCalledTimes(1); expect(first.results[0].following).toBe(false); expect(second.results[0].following).toBe(true);
    const stored = await [...cache.values()][0].clone().json();
    expect(stored[0]).not.toHaveProperty("following"); expect(stored[0]).not.toHaveProperty("channel_id");
  });
  it("enforces the shared ten-second deadline even if the fallback ignores cancellation", async () => {
    const { env } = setup();
    fetch.mockRejectedValue(new Error("blocked"));
    containerFetch.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const result = expect(discoverSources(env, "bilibili", "timeout")).rejects.toThrow("搜索超时");
      await vi.waitFor(() => expect(containerFetch).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(containerFetch).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("retries a failed initial enqueue when re-enabling an older paused follow", async () => {
    const { request, db, env } = setup();
    db.exec("INSERT INTO channel(id,platform,channel_key,key_kind,feed_url,title) VALUES(1,'bilibili','123','provider_id','https://space.bilibili.com/123','Known'); INSERT INTO subscription(user_id,channel_id,feed_url,enabled,last_checked_at) VALUES(1,1,'https://space.bilibili.com/123',0,'2026-01-01')");
    env.PIPELINE.send.mockRejectedValueOnce(new Error("queue down"));
    expect((await request("/follow", { provider: "known", channel_id: 1 })).status).toBe(502);
    expect((await request("/follow", { provider: "known", channel_id: 1 })).status).toBe(200);
    expect(env.PIPELINE.send).toHaveBeenCalledTimes(2);
  });
});

it("filters Folo platforms before limiting results and never returns the service token", async () => {
  const { request } = setup();
  const feeds = Array.from({ length: 12 }, (_, i) => ({ feed: { ...article, id: String(600 + i), url: `https://example.com/feed/${i}` } }));
  feeds.push({ feed: { ...article, id: "999", url: "rsshub://xiaoyuzhou/podcast/123456789012345678901234" } });
  fetch.mockImplementation(async (_url, init) => { expect(init.headers.Authorization).toBe("Bearer server-only-secret"); return Response.json({ data: feeds }); });
  const response = await request("/search?provider=folo&q=podcast&platform=xiaoyuzhou");
  const body = await response.json();
  expect(body.results).toHaveLength(1); expect(body.results[0].provider_id).toBe("999");
  expect(JSON.stringify(body)).not.toContain("server-only-secret");
});

it("polls legacy Xiaoyuzhou page identities through their public RSS bridge", async () => {
  const { env } = setup();
  const { fetchFeed } = await import("../src/lib/feed");
  fetch.mockImplementation(async url => {
    expect(url).toBe("https://rsshub.app/xiaoyuzhou/podcast/5e4ee557418a84a0466737b7");
    return new Response('<rss><channel><title>Podcast</title><item><title>Episode</title><link>https://www.xiaoyuzhoufm.com/episode/123456789012345678901234</link><enclosure url="https://example.com/audio.mp3" type="audio/mpeg" /></item></channel></rss>');
  });
  const feed = await fetchFeed(env, "https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7");
  expect(feed.entries).toHaveLength(1); expect(feed.entries[0].audio).toBe("https://example.com/audio.mp3");
});


it("follows a Xiaoyuzhou search result through verified public cache and enqueues media polling", async () => {
  const { request, db, env } = setup();
  const pid = "682c566cc7c5f17595635a2c";
  fetch.mockImplementation(async () => Response.json({ data: [{ feed: { id: "160287095502623744", title: "半拿铁·周刊", siteUrl: `https://www.xiaoyuzhoufm.com/podcast/${pid}`, url: `rsshub://xiaoyuzhou/podcast/${pid}` } }] }));
  containerFetch.mockImplementation(async req => {
    expect(new URL(req.url).pathname).toBe("/source-inspect");
    expect((await req.json()).url).toBe("https://app.folo.is/feed/160287095502623744");
    return Response.json({ kind: "media", provider: "folo", feed_url: `https://rsshub.app/xiaoyuzhou/podcast/${pid}`, folo_id: "160287095502623744" });
  });
  const response = await request("/follow", { provider: "folo", provider_id: "160287095502623744", q: "半拿铁" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ following: true, kind: "media", platform: "xiaoyuzhou" });
  expect(db.prepare("SELECT title,feed_url FROM channel").get()).toMatchObject({ title: "半拿铁·周刊", feed_url: `https://rsshub.app/xiaoyuzhou/podcast/${pid}` });
  expect(db.prepare("SELECT enabled FROM subscription WHERE user_id=1").get().enabled).toBe(1);
  expect(db.prepare("SELECT count(*) n FROM subscription WHERE user_id=2").get().n).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM rss_follow").get().n).toBe(0);
  expect(env.PIPELINE.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "poll", force: true }));
});
