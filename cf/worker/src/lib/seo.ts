import type { Env } from "../env";

export const ORIGIN = "https://reducer.xgoose.org";
export const SITE_TITLE = "Stream Reducer — Video & Podcast Summaries";
export const SITE_DESCRIPTION =
  "Read clear summaries of YouTube videos, Bilibili videos and podcasts. Explore key ideas, detailed notes and timestamped sources in English and Chinese.";
const PAGE_SIZE = 1000;
const ELIGIBLE =
  "i.status = 'done' AND s.item_id IS NOT NULL AND length(trim(s.markdown)) > 0";
export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
export const plainText = (value: string) =>
  value
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const jsonLd = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");
interface PublicItem {
  status: string;
  id: number;
  title: string;
  headline: string | null;
  subhead: string | null;
  author: string | null;
  source_url: string;
  platform: string;
  thumbnail: string | null;
  completed_at: string | null;
  published_at: string | null;
  markdown: string;
  structured: string;
}
export interface SeoPage {
  title: string;
  description: string;
  canonical: string;
  body: string;
  index: boolean;
  status: number;
  markdown?: string;
  schema?: unknown;
  image?: string;
  language?: string;
}
const searchForm = `<form action="/browse" method="get" role="search"><label for="public-search">Search public summaries</label><div class="flex flex-col gap-3 sm:flex-row mt-3"><input class="flex-1 min-w-0 rounded-md border bg-background px-4 py-3" id="public-search" name="q" type="search" placeholder="Search videos, podcasts, ideas…"/><button class="rounded-md bg-primary text-primary-foreground px-6 py-3" type="submit">Search</button></div></form>`;
const homeIntro = `<h1 class="text-4xl md:text-5xl font-semibold tracking-tight mb-5">Less watching. More understanding.</h1><p class="text-lg text-muted-foreground max-w-2xl mb-3">Turn long videos and podcasts into clear, source-linked reading. Start with the key ideas, go deeper with detailed notes, and return to the exact moment in the original.</p>${searchForm}<nav class="flex flex-wrap gap-5 my-6"><a class="underline" href="/browse">Browse all summaries</a><a class="underline" href="/collections">Explore collections</a><a class="underline" href="/login">Sign in</a></nav><p class="text-sm text-muted-foreground">YouTube, Bilibili, Apple Podcasts &amp; Xiaoyuzhou. Read public summaries without an account; sign in to save content and follow sources.</p>`;
function listing(items: PublicItem[]) {
  return items
    .map(
      (i) =>
        `<article class="py-5 border-b"><p class="text-sm text-muted-foreground mb-2">${escapeHtml(i.author || i.platform)}</p><h3 class="text-xl font-semibold"><a href="/items/${i.id}">${escapeHtml(i.headline || i.title)}</a></h3><p class="text-muted-foreground mt-2">${escapeHtml(i.subhead || plainText(i.markdown).slice(0, 200))}</p></article>`,
    )
    .join("");
}
export async function publicPage(env: Env, url: URL): Promise<SeoPage> {
  const page: SeoPage = {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    canonical: ORIGIN + url.pathname,
    body: "",
    index: false,
    status: 200,
  };
  const match = url.pathname.match(/^\/(?:items|bulletin)\/(\d+)$/);
  if (
    match &&
    (!Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1)
  ) {
    return {
      ...page,
      status: 404,
      title: "Summary unavailable | Stream Reducer",
      body: "<h1>Summary unavailable</h1>",
    };
  }
  if (match) {
    const item = await env.DB.prepare(
      `SELECT i.*, s.markdown, s.structured FROM item i LEFT JOIN summary s ON s.item_id=i.id WHERE i.id=? AND i.status != 'excluded'`,
    )
      .bind(Number(match[1]))
      .first<PublicItem>();
    page.canonical = `${ORIGIN}/items/${Number(match[1])}`;
    if (!item) {
      page.status = 404;
      page.title = "Summary unavailable | Stream Reducer";
      page.body = `<h1>Summary unavailable</h1><p>This public summary is not available.</p><a href="/browse">Browse public summaries</a>`;
      return page;
    }
    if (item.status !== "done" || !item.markdown?.trim()) {
      page.title = `${item.title || "Summary processing"} | Stream Reducer`;
      return page;
    }
    page.language =
      (item.markdown.slice(0, 3000).match(/[\u3400-\u9fff]/g)?.length || 0) >
      300
        ? "zh-CN"
        : "en";
    page.index = true;
    page.title = `${item.headline || item.title} | Stream Reducer`;
    page.description = plainText(item.subhead || item.markdown).slice(0, 180);
    page.image = safeImage(item.thumbnail);
    let structured: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(item.structured);
      if (parsed && typeof parsed === "object") structured = parsed;
    } catch {
      /* legacy summary */
    }
    const points = Array.isArray(structured.bulletin)
      ? structured.bulletin
      : [];
    page.body = `<nav><a href="/">Stream Reducer</a> / <a href="/browse">Public summaries</a></nav><article class="mt-8"><h1 class="text-3xl font-semibold mb-4">${escapeHtml(item.headline || item.title)}</h1><p>${escapeHtml(item.author || item.platform)}</p><p class="text-lg my-4">${escapeHtml(item.subhead)}</p><p>AI-assisted summary of <a class="underline" href="${escapeHtml(safeSource(item.source_url))}" rel="noopener noreferrer">${escapeHtml(item.title)} — original source</a>. Check the original for full context.</p>${item.published_at ? `<p>Source published: <time datetime="${escapeHtml(item.published_at)}">${escapeHtml(item.published_at.slice(0, 10))}</time></p>` : ""}${
      points.length
        ? `<h2 class="text-xl font-semibold mt-8">Key ideas</h2><ul>${points
            .map((point) => {
              const entry = typeof point === "string" ? { text: point } : point;
              if (!entry || typeof entry.text !== "string") return "";
              const at =
                typeof entry.timestamp === "number" && entry.timestamp >= 0
                  ? ` (${Math.floor(entry.timestamp / 60)}:${String(Math.floor(entry.timestamp % 60)).padStart(2, "0")})`
                  : "";
              return `<li>${escapeHtml(entry.text + at)}</li>`;
            })
            .join("")}</ul>`
        : ""
    }<h2 class="text-xl font-semibold mt-8">Detailed notes</h2>${renderNotes(item.markdown)}</article>`;
    page.markdown = `# ${item.headline || item.title}\n\n${item.subhead || ""}\n\nSource: [${item.title}](${safeSource(item.source_url)})\nSource creator: ${item.author || item.platform}\n${item.published_at ? `Source published: ${item.published_at}\n` : ""}Canonical: ${page.canonical}\n\nAI-assisted summary; check the original for full context.\n\n${item.markdown}`;
    page.schema = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: item.headline || item.title,
      description: page.description,
      url: page.canonical,
      mainEntityOfPage: page.canonical,
      inLanguage: page.language,
      ...(item.completed_at ? { datePublished: item.completed_at } : {}),
      ...(page.image ? { image: page.image } : {}),
      publisher: {
        "@type": "Organization",
        name: "Stream Reducer",
        url: ORIGIN,
      },
      isBasedOn: {
        "@type": "CreativeWork",
        name: item.title,
        url: safeSource(item.source_url),
        ...(item.author
          ? { author: { "@type": "Person", name: item.author } }
          : {}),
      },
    };
    return page;
  }
  if (url.pathname === "/" || url.pathname === "/browse") {
    const q = url.searchParams.get("q")?.trim().slice(0, 200) || "";
    const offset = Math.max(
      0,
      Math.min(
        1000000,
        Math.floor(Number(url.searchParams.get("offset")) || 0),
      ),
    );
    const rows = await env.DB.prepare(
      `SELECT i.*, substr(s.markdown,1,500) AS markdown FROM item i JOIN summary s ON s.item_id=i.id WHERE ${ELIGIBLE} ${q ? "AND (i.title LIKE ? OR i.headline LIKE ? OR i.subhead LIKE ? OR i.author LIKE ?)" : ""} ORDER BY i.completed_at DESC, i.id DESC LIMIT ? OFFSET ?`,
    )
      .bind(
        ...(q ? Array(4).fill(`%${q}%`) : []),
        url.pathname === "/" ? 8 : 24,
        offset,
      )
      .all<PublicItem>();
    page.index = !q;
    page.title =
      url.pathname === "/"
        ? SITE_TITLE
        : "Browse Video & Podcast Summaries | Stream Reducer";
    page.body =
      url.pathname === "/"
        ? `${homeIntro}<section class="mt-12"><h2 class="text-2xl font-semibold">Recently summarized</h2>${listing(rows.results)}</section>`
        : `<h1 class="text-3xl font-semibold mb-5">Browse video &amp; podcast summaries</h1>${searchForm}${listing(rows.results)}${rows.results.length === 24 ? `<a href="/browse?offset=${offset + 24}${q ? `&amp;q=${encodeURIComponent(q)}` : ""}">More summaries</a>` : ""}`;
    if (url.pathname === "/browse" && offset)
      page.canonical += `?offset=${offset}`;
    page.schema = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": ORIGIN + "/#website",
      name: "Stream Reducer",
      alternateName: "stream-reduce",
      url: ORIGIN + "/",
      description: SITE_DESCRIPTION,
      inLanguage: ["en", "zh-CN"],
    };
  }
  return page;
}
function renderNotes(markdown: string): string {
  return markdown
    .split(/\n\s*\n/)
    .map((block) => {
      const heading = block.match(/^(#{1,6})\s+([^\n]+)$/);
      if (heading) {
        const level = Math.max(2, heading[1].length);
        return `<h${level} class="text-xl font-semibold mt-6">${escapeHtml(heading[2])}</h${level}>`;
      }
      return `<p class="my-4 whitespace-pre-wrap">${escapeHtml(block)}</p>`;
    })
    .join("");
}
function safeSource(value: string) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? u.href : ORIGIN;
  } catch {
    return ORIGIN;
  }
}
function safeImage(value: string | null) {
  if (!value) return undefined;
  try {
    const u = new URL(value, ORIGIN);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export function pageHead(page: SeoPage) {
  return `<title>${escapeHtml(page.title)}</title><meta name="description" content="${escapeHtml(page.description)}"><meta name="robots" content="${page.index ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" : "noindex, follow"}"><link rel="canonical" href="${escapeHtml(page.canonical)}"><meta property="og:site_name" content="Stream Reducer"><meta property="og:type" content="${page.schema && (page.schema as Record<string, unknown>)["@type"] === "Article" ? "article" : "website"}"><meta property="og:title" content="${escapeHtml(page.title)}"><meta property="og:description" content="${escapeHtml(page.description)}"><meta property="og:url" content="${escapeHtml(page.canonical)}"><meta name="twitter:card" content="${page.image ? "summary_large_image" : "summary"}">${page.image ? `<meta property="og:image" content="${escapeHtml(page.image)}">` : ""}${page.schema ? `<script id="seo-schema" type="application/ld+json">${jsonLd(page.schema)}</script>` : ""}`;
}
export async function serveSeo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/llms.txt") {
    return new Response(
      `# Stream Reducer\n\n> Public, AI-assisted summaries of videos and podcasts, with original source links and timestamped references. English and Chinese reading editions are available in the application.\n\n## Explore\n- [Home](${ORIGIN}/): Product introduction and recent summaries.\n- [Browse](${ORIGIN}/browse): Search public titles and headlines with ?q=.\n- [Sitemap](${ORIGIN}/sitemap.xml): Paginated index of completed public summaries.\n\n## Read and cite\nEach /items/{id} page serves a summary and source attribution in its initial HTML. Append .md for plain Markdown, including the canonical URL and original source. Cite the canonical summary page and attribute underlying claims to the original creator. AI summaries may contain errors; consult the source for full context.\n\n## Access\nPersonal libraries, annotations, RSS/Substack articles and account pages require authentication and are outside this public index. This file is a discovery aid, not an indexing guarantee.\n`,
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      },
    );
  }
  if (/^\/items\/\d+\.md$/.test(url.pathname)) {
    const canonicalUrl = new URL(url);
    canonicalUrl.pathname = canonicalUrl.pathname.slice(0, -3);
    const page = await publicPage(env, canonicalUrl);
    return new Response(page.markdown || "Summary unavailable", {
      status: page.markdown ? 200 : 404,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "x-robots-tag": "noindex",
        link: `<${page.canonical}>; rel="canonical"`,
        "cache-control": "public, max-age=300",
      },
    });
  }
  if (url.pathname === "/robots.txt")
    return new Response(
      `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /media/\nDisallow: /oauth/\nDisallow: /mcp\n\n# Public HTML is available to Googlebot, Bingbot, OAI-SearchBot and ChatGPT-User.\nSitemap: ${ORIGIN}/sitemap.xml\n`,
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      },
    );
  if (
    url.pathname === "/sitemap.xml" ||
    /^\/sitemaps\/items-\d+\.xml$/.test(url.pathname)
  ) {
    const headers = {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=900",
    };
    if (url.pathname === "/sitemap.xml") {
      const count = await env.DB.prepare(
        `SELECT count(*) AS total FROM item i JOIN summary s ON s.item_id=i.id WHERE ${ELIGIBLE}`,
      ).first<{ total: number }>();
      const pages = Math.max(1, Math.ceil((count?.total || 0) / PAGE_SIZE));
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: pages }, (_, i) => `<sitemap><loc>${ORIGIN}/sitemaps/items-${i + 1}.xml</loc></sitemap>`).join("")}</sitemapindex>`,
        { headers },
      );
    }
    const page = Number(url.pathname.match(/items-(\d+)/)![1]);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
      return new Response("Not found", { status: 404 });
    const rows = await env.DB.prepare(
      `SELECT i.id FROM item i JOIN summary s ON s.item_id=i.id WHERE ${ELIGIBLE} ORDER BY i.id LIMIT ? OFFSET ?`,
    )
      .bind(PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all<{ id: number }>();
    if (page > 1 && !rows.results.length)
      return new Response("Not found", { status: 404 });
    const paths = [
      ...(page === 1 ? ["/", "/browse"] : []),
      ...rows.results.map((i) => `/items/${i.id}`),
    ];
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${ORIGIN}${path}</loc></url>`).join("")}</urlset>`,
      { headers },
    );
  }
  const page = await publicPage(env, url);
  const asset = await env.ASSETS.fetch(new Request(new URL("/", request.url)));
  // Serve the same public content to every user-agent, before React starts.
  const html = new HTMLRewriter()
    .on("html", { element(e) { e.setAttribute("lang", page.language || "en"); } })
    .on(
      "title, meta[name=description], meta[name=robots], link[rel=canonical]",
      {
        element(e) {
          e.remove();
        },
      },
    )
    .on("head", {
      element(e) {
        e.append(pageHead(page), { html: true });
      },
    })
    .on("#root", {
      element(e) {
        if (page.body)
          e.setInnerContent(
            `<main class="mx-auto max-w-4xl break-words px-6 py-12">${page.body}</main>`,
            { html: true },
          );
      },
    })
    .transform(asset);
  const headers = new Headers(html.headers);
  headers.delete("etag");
  headers.delete("content-length");
  headers.set("cache-control", "public, max-age=0, s-maxage=300");
  headers.set("x-robots-tag", page.index ? "index, follow" : "noindex, follow");
  return new Response(html.body, { status: page.status, headers });
}
