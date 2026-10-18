import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => ({ fetch: containerFetch }),
}));
const containerFetch = vi.fn();
import {
  monthsAgo,
  followRss,
  persistEntries,
  pollRss,
  drainRss,
  articleChunks,
  validateEdition,
} from "../src/lib/rss";
import { rssRoutes } from "../src/routes/rss";
import { Hono } from "hono";
import { sha256 } from "../src/lib/crypto";
import { database } from "./sqlite.mjs";
const states = [];
function setup() {
  const state = database();
  states.push(state.db);
  state.db.exec(
    "INSERT INTO user(id,email,preferred_language) VALUES(1,'one@example.com','zh'),(2,'two@example.com','auto')",
  );
  const objects = new Map();
  const MEDIA = {
    get: vi.fn(async (key) =>
      objects.has(key)
        ? {
            json: async () => JSON.parse(objects.get(key)),
            text: async () => objects.get(key),
          }
        : null,
    ),
    put: vi.fn(async (key, value) => {
      objects.set(key, value);
    }),
  };
  const RSS_JOBS = {
    send: vi.fn(async () => {}),
    sendBatch: vi.fn(async () => {}),
  };
  return {
    ...state,
    objects,
    env: {
      DB: state.DB,
      MEDIA,
      RSS_JOBS,
      RSS_ENABLED: "true",
      FOLO_OWNER_EMAIL: "one@example.com",
      FOLO_TOKEN: "test",
      LLM_BASE_URL: "https://llm.example.com",
      LLM_MODEL: "test",
      GEMINI_API_KEY: "secret",
    },
  };
}
const source = {
  identity: "feed:https://example.com/feed",
  provider: "rss",
  url: "https://example.com/feed",
  feed_url: "https://example.com/feed",
  folo_id: null,
  title: "Example",
  category: "AI",
};
const entry = (n, date = "2026-10-18T00:00:00Z") => ({
  url: `https://example.com/${n}?utm_source=feed`,
  title: `Article ${n}`,
  published_at: date,
  external_id: `guid-${n}`,
  content:
    "Original source evidence includes ten detailed facts and methods with clear limitations and an important result.",
  content_is_full: true,
});
const body = {
  text: entry(1).content,
  paragraphs: [{ id: 1, text: entry(1).content }],
  completeness: "full",
  method: "feed",
  word_count: 20,
  source_url: "https://example.com/1",
};
const edition = {
  level: "brief",
  reason: "one event",
  headline: "Source headline",
  intro: "Source facts",
  points: ["A fact"],
  sections: [],
  summary_covered: true,
};
async function add(s, n = 1, date) {
  const id = await followRss(s.env, 1, source);
  const row = await s.env.DB.prepare("SELECT * FROM rss_source WHERE id=?")
    .bind(id)
    .first();
  await persistEntries(s.env, row, [entry(n, date)]);
  return row;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const s of states.splice(0)) s.close();
});
describe("independent RSS persistence and processing", () => {
  it("uses calendar months and clamps end-of-month dates", () => {
    expect(monthsAgo(new Date("2026-10-18T06:00:00Z"))).toBe(
      "2026-07-18T06:00:00.000Z",
    );
    expect(monthsAgo(new Date("2026-05-31T00:00:00Z"))).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });
  it("idempotently follows, keeps categories per user and deduplicates across feeds", async () => {
    const s = setup();
    const a = await followRss(s.env, 1, source);
    expect(await followRss(s.env, 1, source)).toBe(a);
    await followRss(s.env, 2, { ...source, category: "Personal" });
    expect(
      s.db.prepare("SELECT category FROM rss_follow WHERE user_id=2").get()
        .category,
    ).toBe("Personal");
    const b = await followRss(s.env, 1, {
      ...source,
      identity: "feed:https://other.example.com",
      feed_url: "https://other.example.com",
    });
    for (const id of [a, b])
      await persistEntries(s.env, { id, backfill_since: "2026-07-18" }, [
        entry(1),
      ]);
    expect(s.db.prepare("SELECT count(*) n FROM rss_article").get().n).toBe(1);
    expect(
      s.db.prepare("SELECT count(*) n FROM rss_source_article").get().n,
    ).toBe(2);
    expect(s.db.prepare("SELECT count(*) n FROM item").get().n).toBe(0);
  });
  it("never advances a source cursor when persistence fails", async () => {
    const s = setup();
    const id = await followRss(s.env, 1, source);
    containerFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          entries: [entry(1)],
          provider: "folo",
          next_before: "2026-08-01T00:00:00Z",
          coverage: "available",
          warning: null,
        }),
      ),
    );
    s.env.MEDIA.put.mockRejectedValue(new Error("storage unavailable"));
    await pollRss(s.env, id);
    const row = s.db.prepare("SELECT * FROM rss_source").get();
    expect(row.backfill_before).toBeNull();
    expect(row.failures).toBe(1);
  });
  it("records history gaps and prevents infinite same-timestamp pagination", async () => {
    const s = setup();
    const id = await followRss(s.env, 1, source);
    containerFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            entries: [entry(1)],
            provider: "folo",
            next_before: "2026-08-01T00:00:00.000Z",
            coverage: "available",
            warning: null,
          }),
        ),
    );
    await pollRss(s.env, id);
    await pollRss(s.env, id, true);
    expect(
      s.db.prepare("SELECT backfill_status FROM rss_source").get()
        .backfill_status,
    ).toBe("gap");
    expect(s.db.prepare("SELECT count(*) n FROM rss_article").get().n).toBe(1);
  });
  it("saves full body before an LLM error and reuses it on retry", async () => {
    const s = setup();
    await add(s);
    containerFetch.mockResolvedValue(new Response(JSON.stringify(body)));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await drainRss(s.env);
    const a = s.db.prepare("SELECT * FROM rss_article").get();
    expect(a.status).toBe("error");
    expect(a.body_key).toMatch(/^rss\/bodies\//);
    s.db.exec("UPDATE rss_article SET next_attempt_at=''");
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(edition) } }],
          }),
        ),
    );
    await drainRss(s.env);
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(s.db.prepare("SELECT count(*) n FROM rss_edition").get().n).toBe(2);
    expect(s.db.prepare("SELECT status FROM rss_article").get().status).toBe(
      "done",
    );
    await drainRss(s.env);
    expect(fetch).toHaveBeenCalledTimes(3); // failed call + original + Chinese
  });
  it("duplicate queue deliveries claim an article once", async () => {
    const s = setup();
    await add(s);
    containerFetch.mockImplementation(
      async () => new Response(JSON.stringify(body)),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(edition) } }],
            }),
          ),
      ),
    );
    await Promise.all([drainRss(s.env), drainRss(s.env)]);
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("processes newest articles first and respects the independent pause", async () => {
    const s = setup();
    await add(s, 1, "2026-09-01");
    await add(s, 2, "2026-10-18");
    containerFetch.mockImplementation(
      async () => new Response(JSON.stringify(body)),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(edition) } }],
            }),
          ),
      ),
    );
    await drainRss(s.env);
    expect(
      s.db.prepare("SELECT title FROM rss_article WHERE status='done'").get()
        .title,
    ).toBe("Article 2");
    s.db.exec("UPDATE rss_control SET paused=1");
    await drainRss(s.env);
    expect(containerFetch).toHaveBeenCalledTimes(1);
  });
  it("keeps excerpts explicit and strips whole-article explanations", () => {
    const result = validateEdition(
      {
        ...edition,
        sections: [{ title: "Theme", text: "Detail", references: [1] }],
      },
      { ...body, completeness: "partial" },
    );
    expect(result.based_on_excerpt).toBe(true);
    expect(result.sections).toEqual([]);
    expect(() =>
      validateEdition(
        {
          ...edition,
          sections: [{ title: "Theme", text: "Detail", references: [9] }],
        },
        body,
      ),
    ).toThrow();
  });
  it("includes the last paragraph when chunking long reports", () => {
    const chunks = articleChunks({
      ...body,
      paragraphs: Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        text: `Paragraph ${i + 1} ` + "x".repeat(900),
      })),
    });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join("")).toContain("[P100] Paragraph 100");
  });
  it("keeps paid and private content out of media tables", async () => {
    const s = setup();
    await add(s);
    expect(s.db.prepare("SELECT count(*) n FROM user_item").get().n).toBe(0);
  });
});

describe("RSS access boundaries", () => {
  async function appFor(s, userId) {
    const token = `test-${userId}`;
    const hash = await sha256(token);
    s.db
      .prepare(
        "INSERT INTO session(token_hash,user_id,expires_at) VALUES(?,?,'2099-01-01')",
      )
      .run(hash, userId);
    const app = new Hono();
    app.route("/api/rss", rssRoutes);
    return (path, method = "GET", body) =>
      app.request(
        `https://reducer.example/api/rss${path}`,
        {
          method,
          headers: {
            cookie: `sr_session=${token}`,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        s.env,
      );
  }
  it("requires authentication and rejects another user reading or retrying a body", async () => {
    const s = setup();
    await add(s);
    const owner = await appFor(s, 1);
    const stranger = await appFor(s, 2);
    expect((await owner("/articles/1")).status).toBe(200);
    for (const path of ["/articles/1", "/articles/1/body"])
      expect((await stranger(path)).status).toBe(404);
    expect((await stranger("/articles/1/retry", "POST", {})).status).toBe(404);
    expect((await stranger("/import/folo", "POST", {})).status).toBe(403);
    const list = await (await stranger("/articles")).json();
    expect(list.articles).toEqual([]);
    const app = new Hono();
    app.route("/api/rss", rssRoutes);
    expect(
      (await app.request("https://example.com/api/rss/sources", {}, s.env))
        .status,
    ).toBe(401);
  });
  it("read and saved state belongs only to the requesting user", async () => {
    const s = setup();
    await add(s);
    await followRss(s.env, 2, source);
    const a = await appFor(s, 1),
      b = await appFor(s, 2);
    await a("/articles/1", "PATCH", { saved: true, read: true });
    const own = await (await a("/articles/1")).json(),
      other = await (await b("/articles/1")).json();
    expect(own.read.saved).toBe(1);
    expect(other.read.saved).toBe(0);
  });
});
