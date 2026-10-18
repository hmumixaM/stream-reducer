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
  RSS_VERSION,
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
  });
  it.each([undefined, [], [9], "invalid legacy field"])(
    "accepts explanations without valid paragraph references (%j)",
    (references) => {
      expect(
        validateEdition(
          {
            ...edition,
            sections: [{ title: "Theme", text: "Detail", references }],
          },
          body,
        ).sections,
      ).toEqual([{ title: "Theme", text: "Detail" }]);
    },
  );
  it.each([null, { title: "Theme", text: 9 }, { text: "Detail" }])(
    "still rejects malformed explanation content (%j)",
    (section) => {
      expect(() =>
        validateEdition({ ...edition, sections: [section] }, body),
      ).toThrow("概括格式不正确");
    },
  );
  it("recovers a reference failure using the saved body and successful original edition", async () => {
    const s = setup();
    await add(s);
    s.objects.set("saved-body", JSON.stringify(body));
    s.db.exec(
      "UPDATE rss_article SET status='error',attempts=0,next_attempt_at='',body_key='saved-body',body_hash='hash',error='概括原文定位不正确'",
    );
    s.db
      .prepare(
        "INSERT INTO rss_edition(article_id,lang,body_hash,version,content,model,tokens) VALUES(1,'original','hash',?,?, 'old-model',0)",
      )
      .run(
        RSS_VERSION,
        JSON.stringify({
          ...edition,
          sections: [
            { title: "Old theme", text: "Saved explanation", references: [1] },
          ],
        }),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      ...edition,
                      sections: [
                        { title: "主题", text: "中文概括", references: [999] },
                      ],
                    }),
                  },
                },
              ],
            }),
          ),
      ),
    );
    await drainRss(s.env);
    expect(containerFetch).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.db.prepare("SELECT status FROM rss_article").get().status).toBe(
      "done",
    );
    const result = s.db
      .prepare("SELECT content FROM rss_edition WHERE lang='zh'")
      .get();
    expect(JSON.parse(result.content).sections).toEqual([
      { title: "主题", text: "中文概括" },
    ]);
    const request = JSON.parse(fetch.mock.calls[0][1].body);
    expect(request.messages[0].content).toContain("Do not include references");
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
  it("lists every personal article follow with poll health, without exposing other users' sources", async () => {
    const s = setup();
    await add(s);
    await followRss(s.env, 2, { ...source, identity: "feed:https://private.example/feed", url: "https://private.example/feed", title: "Other user source" });
    const owner = await appFor(s, 1), stranger = await appFor(s, 2);
    s.db.exec("UPDATE rss_source SET last_checked_at='2026-10-18T20:00:00Z',next_poll_at='2026-10-18T20:30:00Z',poll_count=3 WHERE id=1");
    const ownRows = await (await owner("/sources")).json();
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0]).toMatchObject({ id: 1, title: "Example", article_count: 1, latest_published_at: "2026-10-18T00:00:00Z", poll_count: 3, next_poll_at: "2026-10-18T20:30:00Z" });
    expect((await (await stranger("/sources")).json()).map(x => x.title)).toEqual(["Other user source"]);
    s.env.RSS_JOBS.send.mockClear();
    expect((await stranger("/sources/1/refresh", "POST", {})).status).toBe(404);
    expect(s.env.RSS_JOBS.send).not.toHaveBeenCalled();
    expect((await owner("/sources/1/refresh", "POST", {})).status).toBe(200);
    expect(s.env.RSS_JOBS.send).toHaveBeenCalledWith({ kind: "rss_poll", source_id: 1 });
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

describe("verified canonical identities", () => {
  it("merges aliases, source links and personal state while preserving old IDs", async () => {
    const { linkCanonical } = await import("../src/lib/rss");
    const s = setup();
    await add(s, 1);
    await add(s, 2);
    s.db.exec(
      "UPDATE rss_article SET lease_token='owner' WHERE id=2; INSERT INTO rss_read(user_id,article_id,saved) VALUES(1,2,1)",
    );
    const article = await s.env.DB.prepare(
      "SELECT * FROM rss_article WHERE id=2",
    ).first();
    expect(await linkCanonical(s.env, article, "https://example.com/1")).toBe(
      true,
    );
    expect(
      s.db.prepare("SELECT count(*) n FROM rss_source_article").get().n,
    ).toBe(1);
    expect(
      s.db
        .prepare("SELECT saved FROM rss_read WHERE user_id=1 AND article_id=1")
        .get().saved,
    ).toBe(1);
    expect(
      s.db
        .prepare(
          "SELECT article_id FROM rss_alias WHERE alias='url:https://example.com/2'",
        )
        .get().article_id,
    ).toBe(1);
    expect(
      s.db.prepare("SELECT status FROM rss_article WHERE id=2").get().status,
    ).toBe("merged");
  });
  it("resumes a changed full seed without regenerating unchanged content", async () => {
    const s = setup();
    const source = await add(s, 1);
    await persistEntries(s.env, source, [entry(1)]);
    const before = s.env.MEDIA.put.mock.calls.length;
    await persistEntries(s.env, source, [entry(1)]);
    expect(s.env.MEDIA.put.mock.calls.length).toBe(before);
    s.db.exec(
      "UPDATE rss_article SET status='done',body_key='old',completeness='partial'",
    );
    await persistEntries(s.env, source, [
      {
        ...entry(1),
        content: entry(1).content + " Another new and detailed paragraph.",
      },
    ]);
    expect(
      s.db.prepare("SELECT status,body_key FROM rss_article").get(),
    ).toMatchObject({ status: "queued", body_key: null });
  });
});

describe("RSS Chinese editions", () => {
  it("reuses a Chinese original instead of making the same model request twice", async () => {
    const s = setup();
    await add(s);
    const text =
      "这是完整的中文文章，包含明确的事实、具体数字和必要的背景信息，没有要求补充原文之外的内容。";
    containerFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ ...body, text, paragraphs: [{ id: 1, text }] }),
      ),
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
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.db.prepare("SELECT count(*) n FROM rss_edition").get().n).toBe(2);
  });
});

describe("RSS deployment capacity recovery", () => {
  it("does not spend article attempts or source failure counts on container provisioning", async () => {
    const s = setup();
    const source = await add(s);
    containerFetch.mockRejectedValue(
      new Error(
        "There is no container instance that can be provided to this Durable Object, try again later",
      ),
    );
    await pollRss(s.env, source.id);
    expect(s.db.prepare("SELECT failures FROM rss_source").get().failures).toBe(
      0,
    );
    await drainRss(s.env);
    expect(
      s.db.prepare("SELECT status,attempts FROM rss_article").get(),
    ).toMatchObject({ status: "queued", attempts: 0 });
    expect(s.env.RSS_JOBS.send).toHaveBeenLastCalledWith(
      { kind: "rss_drain" },
      { delaySeconds: 60 },
    );
  });
});
