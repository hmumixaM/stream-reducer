import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => ({ fetch: vi.fn() }),
}));
import { Hono } from "hono";
import { database } from "./sqlite.mjs";
import { sha256 } from "../src/lib/crypto";
import { bulletinRoutes } from "../src/routes/bulletin";
import { rssRoutes } from "../src/routes/rss";
const databases = [];
async function setup() {
  const s = database();
  databases.push(s.db);
  s.db
    .exec(`INSERT INTO user(id,email,preferred_language) VALUES(1,'one@example.com','zh'),(2,'two@example.com','auto');
    INSERT INTO rss_source(id,identity,provider,url,feed_url,folo_id,title,backfill_since) VALUES(1,'public','folo','https://app.folo.is/feed/123','https://publisher.example/feed','123','Publisher','2026-07-18');
    INSERT INTO rss_follow(user_id,source_id,category) VALUES(1,1,'Private folder');`);
  for (let id = 1; id <= 3; id++) {
    s.item(id, id === 3 ? "2026-10-17" : "2026-10-18");
    s.db.prepare("INSERT INTO user_item(user_id,item_id) VALUES(1,?)").run(id);
    s.db.prepare("UPDATE item SET platform='youtube' WHERE id=?").run(id);
    s.db
      .prepare(
        "INSERT INTO rss_article(id,url,title,published_at,body_hash,status) VALUES(?,?,?,'2026-10-18','hash','done')",
      )
      .run(id, `https://publisher.example/${id}`, `Article ${id}`);
    s.db
      .prepare(
        "INSERT INTO rss_source_article(source_id,article_id) VALUES(1,?)",
      )
      .run(id);
    for (const lang of ["original", "zh"])
      s.db
        .prepare(
          "INSERT INTO rss_edition(article_id,lang,body_hash,version,content,model) VALUES(?,?,'hash','rss-v1',?,'test')",
        )
        .run(
          id,
          lang,
          JSON.stringify({
            headline: lang === "zh" ? `中文文章 ${id}` : `Article ${id}`,
            intro: "Overview",
            points: ["Point"],
            sections: [{ title: "Detail", text: "LONG PRIVATE ARTICLE NOTES" }],
            based_on_excerpt: id === 2,
          }),
        );
  }
  s.db.exec(
    "UPDATE bulletin_translation SET status='done',headline='中文视频',tldr='中文概览',bulletin='[\"中文要点\"]'; INSERT INTO rss_read(user_id,article_id,saved) VALUES(1,2,1)",
  );
  const tokens = [];
  for (let user = 1; user <= 2; user++) {
    const token = `session-${user}`;
    tokens[user] = token;
    s.db
      .prepare(
        "INSERT INTO session(token_hash,user_id,expires_at) VALUES(?,?,'2099-01-01')",
      )
      .run(await sha256(token), user);
  }
  const app = new Hono();
  app.route("/api/bulletin", bulletinRoutes);
  app.route("/api/rss", rssRoutes);
  const env = {
    DB: s.DB,
    RSS_JOBS: { send: vi.fn(async () => {}) },
    RSS_ENABLED: "true",
    FOLO_OWNER_EMAIL: "one@example.com",
    FOLO_TOKEN: "private-token",
  };
  const request = (path, user = 1, method = "GET") =>
    app.request(
      path,
      {
        method,
        headers: {
          cookie: `sr_session=${tokens[user]}`,
          "content-type": "application/json",
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      },
      env,
    );
  return { ...s, request, env };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe("articles in the main Bulletin", () => {
  it("paginates mixed media and articles with colliding IDs and dates without duplicates or missing rows", async () => {
    const s = await setup();
    let cursor;
    const rows = [];
    do {
      const response = await s.request(
        `/api/bulletin/feed?limit=1${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      expect(response.status).toBe(200);
      const page = await response.json();
      rows.push(...page.items);
      cursor = page.next_cursor;
      expect(rows.length).toBeLessThanOrEqual(6);
    } while (cursor);
    expect(rows.map((x) => `${x.content_type}:${x.id}`)).toEqual([
      "article:3",
      "article:2",
      "article:1",
      "media:2",
      "media:1",
      "media:3",
    ]);
    expect(rows[0]).toMatchObject({
      title: "中文文章 3",
      author: "Publisher",
      bulletin_language: "zh",
      bulletin_points: [{ text: "Point", timestamp: null }],
    });
    expect(JSON.stringify(rows)).not.toContain("LONG PRIVATE");
    const offset = await (
      await s.request("/api/bulletin/feed?limit=2&offset=2")
    ).json();
    expect(offset.items.map((x) => `${x.content_type}:${x.id}`)).toEqual([
      "article:1",
      "media:2",
    ]);
  });
  it("filters platforms, source, search and saved state within the user follows", async () => {
    const { request } = await setup();
    const list = async (q, user = 1) =>
      (await (await request("/api/bulletin/feed?" + q, user)).json()).items;
    expect((await list("platform=article")).map((x) => x.id)).toEqual([
      3, 2, 1,
    ]);
    expect(
      (await list("platform=youtube")).every((x) => x.content_type === "media"),
    ).toBe(true);
    expect((await list("q=Publisher")).length).toBe(3);
    expect((await list("q=中文文章")).length).toBe(3);
    expect((await list("source=1")).length).toBe(3);
    expect((await list("source=999")).length).toBe(0);
    expect(
      (await list("platform=article&saved=true")).map((x) => x.id),
    ).toEqual([2]);
    expect(await list("", 2)).toEqual([]);
    expect((await request("/api/bulletin/feed?source=invalid")).status).toBe(
      400,
    );
  });
  it("lets another user discover and follow a public source without Folo login or owner state", async () => {
    const { request, db, env } = await setup();
    const catalog = await (await request("/api/rss/catalog", 2)).json();
    expect(catalog[0]).toMatchObject({
      id: 1,
      title: "Publisher",
      following: 0,
    });
    expect(JSON.stringify(catalog)).not.toMatch(
      /Private folder|private-token|one@example/,
    );
    expect((await request("/api/rss/sources/1/follow", 2, "POST")).status).toBe(
      201,
    );
    expect((await request("/api/rss/sources/1/follow", 2, "POST")).status).toBe(
      201,
    );
    expect(db.prepare("SELECT count(*) n FROM rss_source").get().n).toBe(1);
    expect(
      db.prepare("SELECT category FROM rss_follow WHERE user_id=2").get()
        .category,
    ).toBe("");
    const page = await (await request("/api/bulletin/feed", 2)).json();
    expect(page.items).toHaveLength(3);
    expect(
      page.items.every((x) => !x.saved && x.bulletin_language === "original"),
    ).toBe(true);
    expect(env.RSS_JOBS.send).toHaveBeenCalledWith({
      kind: "rss_poll",
      source_id: 1,
    });
    await request("/api/rss/sources/1", 2, "DELETE");
    expect(
      (await (await request("/api/bulletin/feed", 2)).json()).items,
    ).toEqual([]);
    expect(
      (await (await request("/api/bulletin/feed")).json()).items,
    ).toHaveLength(6);
  });
});
