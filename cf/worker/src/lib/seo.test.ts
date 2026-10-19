import { describe, it, expect } from "vitest";
import { publicPage, pageHead, serveSeo, escapeHtml } from "./seo";
import type { Env } from "../env";
function database(row: unknown = null, rows: unknown[] = []) {
  const queries: { sql: string; args: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const q = { sql, args: [] as unknown[] };
        queries.push(q);
        return {
          bind(...args: unknown[]) {
            q.args = args;
            return this;
          },
          async first() {
            return row;
          },
          async all() {
            return { results: rows };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, queries };
}
const item = {
  id: 9,
  status: "done",
  title: "A useful conversation",
  headline: "How retrieval works",
  subhead: "Evidence and context",
  source_url: "https://example.com/episode",
  author: "Original creator",
  platform: "youtube",
  thumbnail: "https://example.com/image.png",
  published_at: "2026-10-01T12:00:00Z",
  completed_at: "2026-10-02T12:00:00Z",
  markdown:
    "## Context\n\nA complete summary with original claims.\n\n<script>alert('x')</script>",
  structured: JSON.stringify({
    bulletin: [{ text: "Useful point", timestamp: 93 }],
  }),
};
describe("public search and AI retrieval", () => {
  it("serves source-linked content and a stable canonical across both readers", async () => {
    const { env } = database(item);
    const page = await publicPage(
      env,
      new URL("https://evil.example/bulletin/9?from=/browse&view=notes"),
    );
    expect(page.index).toBe(true);
    expect(page.canonical).toBe("https://reducer.xgoose.org/items/9");
    expect(page.body).toContain("Original creator");
    expect(page.body).toContain("1:33");
    expect(page.body).toContain("A complete summary");
    expect(page.body).not.toContain("<script>alert");
    const schema = page.schema as Record<string, unknown>;
    expect(schema.datePublished).toBe(item.completed_at);
    expect(schema.isBasedOn).toMatchObject({
      url: item.source_url,
      author: { name: item.author },
    });
  });
  it("escapes metadata and JSON-LD against HTML injection", async () => {
    const { env } = database({
      ...item,
      headline: '</script><script>alert("x")</script>',
    });
    const head = pageHead(
      await publicPage(env, new URL("https://reducer.xgoose.org/items/9")),
    );
    expect(head).not.toContain("</script><script>alert");
    expect(head).toContain("\\u003c/script>");
    expect(escapeHtml('"<&')).toBe("&quot;&lt;&amp;");
  });
  it("does not index absent, excluded, or unfinished summaries", async () => {
    const absent = database();
    const missing = await publicPage(
      absent.env,
      new URL("https://reducer.xgoose.org/items/88"),
    );
    expect(missing.status).toBe(404);
    expect(missing.index).toBe(false);
    expect(absent.queries[0].sql).toContain("i.status != 'excluded'");
    const pending = await publicPage(
      database({ ...item, status: "queued", markdown: null }).env,
      new URL("https://reducer.xgoose.org/items/9"),
    );
    expect(pending.status).toBe(200);
    expect(pending.index).toBe(false);
    expect(pending.markdown).toBeUndefined();
    expect(
      (
        await publicPage(
          database(item).env,
          new URL("https://reducer.xgoose.org/rss/articles/9"),
        )
      ).index,
    ).toBe(false);
  });
  it("uses bound search parameters and crawlable pagination without indexing search results", async () => {
    const { env, queries } = database(null, Array(24).fill(item));
    const page = await publicPage(
      env,
      new URL("https://reducer.xgoose.org/browse?q=AI%26robots&offset=24"),
    );
    expect(page.index).toBe(false);
    expect(queries[0].args).toEqual([
      "%AI&robots%",
      "%AI&robots%",
      "%AI&robots%",
      "%AI&robots%",
      24,
      24,
    ]);
    expect(page.body).toContain("offset=48&amp;q=AI%26robots");
    expect(queries[0].sql).toContain("i.status = 'done'");
  });
  it("publishes a bounded sitemap index and only canonical completed content", async () => {
    const { env } = database({ total: 2001 });
    const response = await serveSeo(
      new Request("https://reducer.xgoose.org/sitemap.xml"),
      env,
    );
    expect(await response.text()).toContain("items-3.xml");
    const { env: child, queries } = database(null, [{ id: 9 }]);
    const xml = await (
      await serveSeo(
        new Request("https://reducer.xgoose.org/sitemaps/items-2.xml"),
        child,
      )
    ).text();
    expect(queries[0].args).toEqual([1000, 1000]);
    expect(xml).toContain("/items/9</loc>");
    expect(xml).not.toContain("/bulletin/");
    expect(
      (
        await serveSeo(
          new Request("https://reducer.xgoose.org/sitemaps/items-0.xml"),
          child,
        )
      ).status,
    ).toBe(404);
  });
  it("makes source-attributed Markdown available without a duplicate index entry", async () => {
    const response = await serveSeo(
      new Request("https://reducer.xgoose.org/items/9.md"),
      database(item).env,
    );
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("link")).toContain("/items/9>;");
    expect(await response.text()).toContain("Source creator: Original creator");
  });
  it("allows public discovery without advertising private API paths", async () => {
    const robots = await (
      await serveSeo(
        new Request("https://reducer.xgoose.org/robots.txt"),
        database().env,
      )
    ).text();
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Sitemap: https://reducer.xgoose.org/sitemap.xml");
    const llms = await (
      await serveSeo(
        new Request("https://reducer.xgoose.org/llms.txt"),
        database().env,
      )
    ).text();
    expect(llms).toContain("original source");
  });
});
