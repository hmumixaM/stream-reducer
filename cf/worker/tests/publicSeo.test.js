import { describe, it, expect, afterEach } from "vitest";
import { database } from "./sqlite.mjs";
import { publicPage, pageHead, serveSeo } from "../src/lib/seo";
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
      "Complete transcript",
      "0:12",
      "<img",
      "cover.jpg",
    ])
      expect(page.body + (page.supplemental || "")).toContain(text);
    expect(page.markdown).toContain("Complete transcript");
    expect(page.supplemental).not.toContain("完整中文笔记");
    const translated = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/items/1?lang=zh&from=/browse"),
    );
    expect(translated.canonical).toBe(
      "https://reducer.xgoose.org/items/1?lang=zh",
    );
    expect(translated.language).toBe("zh-CN");
    expect(translated.body + translated.supplemental).toContain("完整中文笔记");
    expect(translated.supplemental).toContain("中文引文");
    expect(translated.supplemental).not.toContain("Complete transcript");
    expect(pageHead(translated)).toContain(
      'hreflang="en" href="https://reducer.xgoose.org/items/1"',
    );
    expect(pageHead(page)).toContain(
      'hreflang="zh-Hans" href="https://reducer.xgoose.org/items/1?lang=zh"',
    );
    const unavailable = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/items/1?lang=fr"),
    );
    expect(unavailable.index).toBe(false);
    expect(unavailable.canonical).toBe("https://reducer.xgoose.org/items/1");
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
      "Full saved source text",
    ])
      expect(page.body + (page.supplemental || "")).toContain(t);
    const translated = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/rss/articles/1?lang=zh"),
    );
    expect(translated.index).toBe(true);
    expect(translated.language).toBe("zh-CN");
    expect(translated.canonical).toBe(
      "https://reducer.xgoose.org/rss/articles/1?lang=zh",
    );
    expect(translated.body + translated.supplemental).toContain("中文概括");
    expect(translated.supplemental).not.toContain("Full saved source text");
    expect(pageHead(page)).toContain('hreflang="zh-Hans"');
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
  it("publishes only completed public collection members with localized links and discovery", async () => {
    const s = setup();
    s.item(1, "2026-10-01");
    s.item(2, "2026-10-02");
    s.item(3, "2026-10-03");
    s.db.exec(`UPDATE item SET status='excluded' WHERE id=2;
      UPDATE item SET status='queued' WHERE id=3;
      INSERT INTO collection(id,slug,title,description,is_public) VALUES(1,'conference','AI & Conference','Useful talks',1),(2,'private','Private conference','Private text',0),(3,'empty','Upcoming conference','No talks yet',1);
      INSERT INTO collection_item(collection_id,item_id,position) VALUES(1,1,0),(1,2,1),(1,3,2),(2,1,0);
      INSERT INTO item_translation(item_id,lang,status,markdown,structured) VALUES(1,'zh','done','中文内容','{"headline":"中文演讲标题","subhead":"中文内容简介"}');`);
    const en = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/collections/conference"),
    );
    expect(en.index).toBe(true);
    expect(en.body).toContain("/items/1");
    expect(en.body).not.toContain("/items/2");
    expect(en.body).not.toContain("/items/3");
    expect(pageHead(en)).toContain("AI &amp; Conference");
    const zh = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/collections/conference?lang=zh"),
    );
    expect(zh.index).toBe(true);
    expect(zh.body).toContain("中文演讲标题");
    expect(zh.canonical).toBe(
      "https://reducer.xgoose.org/collections/conference?lang=zh",
    );
    expect(zh.body).toContain("/items/1?lang=zh");
    expect(
      (
        await publicPage(
          s.env,
          new URL("https://reducer.xgoose.org/collections/private"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await publicPage(
          s.env,
          new URL("https://reducer.xgoose.org/collections/empty"),
        )
      ).index,
    ).toBe(false);
    const listing = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/collections"),
    );
    expect(listing.body).toContain("/collections/conference");
    expect(listing.body).not.toContain("Private text");
    const xml = await (
      await serveSeo(
        new Request("https://reducer.xgoose.org/sitemaps/collections.xml"),
        s.env,
      )
    ).text();
    expect(xml).toContain("/collections/conference?lang=zh");
    expect(xml).not.toContain("/collections/private");
    expect(xml).not.toContain("/collections/empty");
    const items = await (
      await serveSeo(
        new Request("https://reducer.xgoose.org/sitemaps/items-1.xml"),
        s.env,
      )
    ).text();
    expect(items).toContain("/items/1?lang=zh");
    expect(items).not.toContain("/items/2");
    expect(items).not.toContain("/items/3");
  });
  it("gives stored additional languages their own canonical without indexing missing editions", async () => {
    const s = setup();
    s.item(1, "2026-10-01");
    s.db.exec(
      `INSERT INTO item_translation(item_id,lang,status,markdown,structured) VALUES(1,'fr','done','Un résumé en français avec des sources.','{"headline":"Le développement des agents"}'),(1,'de','error','','{}');`,
    );
    const page = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/items/1?lang=fr"),
    );
    expect(page.index).toBe(true);
    expect(page.language).toBe("fr");
    expect(page.canonical).toBe("https://reducer.xgoose.org/items/1?lang=fr");
    expect(page.body).toContain("Un résumé en français");
    expect(pageHead(page)).toContain('hreflang="fr"');
    expect(pageHead(page)).not.toContain('hreflang="de"');
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
  it("balances creators while sampling only their most-viewed usable English summaries", async () => {
    const s = setup();
    const metadata = s.db.prepare(
      "UPDATE item SET view_count=?,author=? WHERE id=?",
    );
    const transcript = s.db.prepare(
      "INSERT INTO transcript(item_id,language,source,text) VALUES(?,?,'native','Source transcript')",
    );
    for (let creator = 0; creator < 12; creator++) {
      // One channel has far more entries and views than every other channel.
      const count = creator === 0 ? 200 : 8;
      for (let rank = 1; rank <= count; rank++) {
        const id = creator * 1000 + rank;
        s.item(id, "2026-10-01");
        metadata.run(
          rank * 1000 * (creator === 0 ? 100000 : 1),
          creator === 0 && rank % 2
            ? " DIARY OF A CEO "
            : creator === 0
              ? "Diary Of A CEO"
              : `Creator ${creator}`,
          id,
        );
        transcript.run(id, rank % 2 ? "en-orig" : "en_US");
      }
    }
    for (const [id, language] of [
      [13001, "zh"],
      [13002, null],
      [13003, "en"],
    ]) {
      s.item(id, "2026-10-01");
      metadata.run(999999999, "Ineligible", id);
      transcript.run(id, language);
    }
    s.db.exec("DELETE FROM summary WHERE item_id=13003");
    // Repeat to exercise random choices, not a lucky single sample.
    for (let request = 0; request < 8; request++) {
      const page = await publicPage(
        s.env,
        new URL("https://reducer.xgoose.org/"),
      );
      const ids = [...page.body.matchAll(/href="\/items\/(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      expect(ids).toHaveLength(8);
      const creators = ids.map((id) => Math.floor(id / 1000));
      expect(new Set(creators).size).toBe(8);
      expect(
        ids.every(
          (id) =>
            Math.floor(id / 1000) < 12 && id % 1000 >= (id < 1000 ? 196 : 4),
        ),
      ).toBe(true);
      expect(page.body).toContain("Popular picks");
      expect(page.body).toContain("different creator");
    }
  });
  it("uses metadata indexes for catalogue eligibility and ordered pagination", async () => {
    const s = setup();
    for (let id = 1; id <= 80; id++) s.item(id, "2026-10-01");
    s.db.exec(`UPDATE item SET completed_at=printf('2026-10-%02d', id % 28 + 1),
      author='Creator ' || id, view_count=id*100;
      INSERT INTO transcript(item_id,language,source,text)
      SELECT id,'en-US','native','Transcript' FROM item;
      UPDATE summary SET markdown='   ' WHERE item_id=80;
      UPDATE item SET status='excluded' WHERE id=79;`);
    const queries = [];
    const prepare = s.DB.prepare.bind(s.DB);
    s.DB.prepare = (sql) => {
      queries.push(sql);
      return prepare(sql);
    };
    const browse = await publicPage(
      s.env,
      new URL("https://reducer.xgoose.org/browse?offset=24"),
    );
    const ids = [...browse.body.matchAll(/href="\/items\/(\d+)"/g)].map((m) =>
      Number(m[1]),
    );
    const expected = s.db
      .prepare(
        `SELECT i.id FROM item i JOIN summary s ON s.item_id=i.id
      WHERE i.status='done' AND length(trim(s.markdown))>0
      ORDER BY i.completed_at DESC,i.id DESC LIMIT 24 OFFSET 24`,
      )
      .all()
      .map((r) => r.id);
    expect(ids).toEqual(expected);
    await publicPage(s.env, new URL("https://reducer.xgoose.org/"));
    await serveSeo(
      new Request("https://reducer.xgoose.org/sitemap.xml"),
      s.env,
    );
    for (const sql of queries.filter((q) =>
      q.includes("ix_summary_public_item"),
    )) {
      const args = Array((sql.match(/\?/g) || []).length).fill(24);
      const plan = s.db
        .prepare("EXPLAIN QUERY PLAN " + sql)
        .all(...args)
        .map((r) => r.detail)
        .join("\n");
      expect(plan).toContain("ix_summary_public_item");
      if (sql.includes("ORDER BY i.completed_at")) {
        expect(plan).toContain("ix_item_status_completed");
        expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
      }
      if (sql.includes("ix_transcript_item_language")) {
        expect(plan).toContain("COVERING INDEX ix_transcript_item_language");
      }
      // Eligibility is already recorded in the partial index. SQLite must not
      // evaluate trim(markdown) against every complete summary on each visit.
      const ops = s.db.prepare("EXPLAIN " + sql).all(...args);
      expect(
        ops.filter(
          (r) => r.opcode === "Function" && String(r.p4).startsWith("length("),
        ),
      ).toEqual([]);
    }
    // Index entries follow edits, so newly empty/usable summaries stay correct.
    s.db.exec(
      "UPDATE summary SET markdown='' WHERE item_id=1; UPDATE summary SET markdown='Restored' WHERE item_id=80;",
    );
    const eligible = s.db
      .prepare(
        "SELECT item_id FROM summary INDEXED BY ix_summary_public_item WHERE length(trim(markdown))>0",
      )
      .all()
      .map((r) => r.item_id);
    expect(eligible).not.toContain(1);
    expect(eligible).toContain(80);
  });
});
