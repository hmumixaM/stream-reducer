import { describe, it, expect, afterEach } from "vitest";
import { database } from "./sqlite.mjs";
import { publicPage, serveSeo } from "../src/lib/seo";
import { publicArticlesRoutes } from "../src/routes/publicArticles";
import { Hono } from "hono";
import { sourceHash, READING_VERSION } from "../src/lib/readingSummary";
const states = [];
function setup() {
  const s = database();
  states.push(s.db);
  return {
    ...s,
    env: {
      DB: s.DB,
      MEDIA: {
        get: async () => ({
          json: async () => ({
            text: "Full saved source text",
            paragraphs: [{ id: 1, text: "Full saved source text" }],
            completeness: "full",
            snapshot: "DO NOT EXPOSE SNAPSHOT",
            source_url: "https://example.com/article",
          }),
        }),
      },
    },
  };
}
afterEach(() => states.splice(0).forEach((d) => d.close()));
function article(s) {
  s.db.exec(
    `INSERT INTO rss_article(id,url,title,author,status,body_hash,body_key,completeness) VALUES(1,'https://example.com/article','Source article','Writer','done','hash','private-r2-key','full');`,
  );
  const edition = {
    headline: "Useful article headline",
    intro: "An accurate summary.",
    points: ["One claim"],
    sections: [{ title: "Evidence", text: "Evidence explained" }],
  };
  s.db
    .prepare(
      "INSERT INTO rss_edition(article_id,lang,body_hash,version,content,model) VALUES(1,?,'hash','rss-v1',?,'test')",
    )
    .run("original", JSON.stringify(edition));
  s.db
    .prepare(
      "INSERT INTO rss_edition(article_id,lang,body_hash,version,content,model) VALUES(1,?,'hash','rss-v1',?,'test')",
    )
    .run(
      "zh",
      JSON.stringify({ ...edition, intro: "中文概括", headline: "中文标题" }),
    );
}
describe("complete public HTML and article access", () => {
  it("renders cached reading summaries, translations, quotes, timestamps, transcript and cover in initial HTML", async () => {
    const s = setup();
    s.item(1, "2026-10-01");
    s.db.exec(
      "UPDATE item SET thumbnail='https://example.com/cover.jpg' WHERE id=1",
    );
    const source = await s.DB.prepare(
      "SELECT i.*,s.markdown AS summary_markdown,s.structured AS summary_structured FROM item i JOIN summary s ON s.item_id=i.id WHERE i.id=1",
    ).first();
    const hash = await sourceHash(source);
    const content = {
      lead: "Concise lead",
      sections: [
        {
          heading: "Evidence",
          body: "Grounded reading paragraph",
          timestamp: 12,
        },
        { heading: "Limits", body: "A limitation", timestamp: null },
      ],
      conclusion: "Conclusion",
    };
    s.db
      .prepare(
        "INSERT INTO reading_summary(item_id,source_hash,version,status,content,updated_at) VALUES(1,?,?,'done',?,'2026-10-18T00:00:00Z')",
      )
      .run(hash, READING_VERSION, JSON.stringify(content));
    s.db.exec(
      `INSERT INTO item_translation(item_id,lang,status,markdown,structured) VALUES(1,'zh','done','完整中文笔记','{"quotes":[{"text":"中文引文","timestamp":12}]}');INSERT INTO transcript(item_id,text,segments,source) VALUES(1,'Complete transcript','[{"start":12,"text":"Complete transcript"}]','native');`,
    );
    const page = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/items/1"),
    );
    for (const text of [
      "Concise lead",
      "Grounded reading paragraph",
      "完整中文笔记",
      "中文引文",
      "Complete transcript",
      "0:12",
      "<img",
      "cover.jpg",
      'lang="zh-CN"',
    ])
      expect(page.body + (page.supplemental || "")).toContain(text);
    expect(page.markdown).toContain("Complete transcript");
    s.db.exec("UPDATE reading_summary SET source_hash='stale'");
    expect(
      (await publicPage(s.env, new URL("https://reducer.xgoose.org/items/1")))
        .supplemental,
    ).not.toContain("Concise lead");
  });
  it("exposes complete article editions and body without account metadata or generation", async () => {
    const s = setup();
    article(s);
    const page = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/rss/articles/1"),
    );
    expect(page.index).toBe(true);
    for (const t of [
      "An accurate summary",
      "Evidence explained",
      "中文概括",
      "Full saved source text",
    ])
      expect(page.body + (page.supplemental || "")).toContain(t);
    expect(page.body).not.toContain("private-r2-key");
    const app = new Hono().route("/api/public/articles", publicArticlesRoutes);
    const response = await app.request("/api/public/articles/1", {}, s.env);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.editions).toHaveLength(2);
    expect(json.read.saved).toBe(0);
    for (const name of [
      "body_key",
      "body_hash",
      "lease_token",
      "connection_id",
      "error",
    ])
      expect(json).not.toHaveProperty(name);
    const body = await (
      await app.request("/api/public/articles/1/body", {}, s.env)
    ).json();
    expect(body.text).toBe("Full saved source text");
    expect(body).not.toHaveProperty("snapshot");
    expect(
      (await app.request("/api/public/articles/1", { method: "PATCH" }, s.env))
        .status,
    ).toBe(404);
  });
  it("excludes pending/merged and stale editions from public discovery", async () => {
    const s = setup();
    article(s);
    s.db.exec("UPDATE rss_edition SET body_hash='old'");
    expect(
      (
        await publicPage(
          s.env,
          new URL("https://reducer.xgoose.org/rss/articles/1"),
        )
      ).status,
    ).toBe(404);
    s.db.exec(
      "UPDATE rss_edition SET body_hash='hash';UPDATE rss_article SET status='merged'",
    );
    expect(
      (
        await publicPage(
          s.env,
          new URL("https://reducer.xgoose.org/rss/articles/1"),
        )
      ).status,
    ).toBe(404);
  });
  it("includes articles and cover images in sitemaps with matching anonymous discovery", async () => {
    const s = setup();
    article(s);
    s.item(1, "2026-10-01");
    s.db.exec(
      "UPDATE item SET thumbnail='https://example.com/cover.jpg?a=1&b=2' WHERE id=1",
    );
    const xml = async (p) =>
      (
        await serveSeo(new Request("https://reducer.xgoose.org" + p), s.env)
      ).text();
    expect(await xml("/sitemap.xml")).toContain("articles-1.xml");
    expect(await xml("/sitemaps/articles-1.xml")).toContain(
      "/rss/articles/1</loc>",
    );
    expect(await xml("/sitemaps/items-1.xml")).toContain(
      "<image:loc>https://example.com/cover.jpg?a=1&amp;b=2</image:loc>",
    );
    const listing = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/articles"),
    );
    expect(listing.body).toContain("/rss/articles/1");
    expect(
      (
        await publicPage(
          s.env,
          new URL("https://reducer.xgoose.org/articles?q=Source"),
        )
      ).index,
    ).toBe(false);
  });
});
