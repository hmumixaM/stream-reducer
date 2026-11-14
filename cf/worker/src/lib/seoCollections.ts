import type { Env } from "../env";
import { ORIGIN, escapeHtml, plainText, type SeoPage } from "./seo";
import { languagePlan } from "./seoLanguages";

interface Collection {
  id: number;
  slug: string;
  title: string;
  description: string;
  source_url: string;
}
interface Entry {
  id: number;
  title: string;
  headline: string | null;
  subhead: string | null;
  markdown: string;
  author: string | null;
  zh_headline: string | null;
  zh_subhead: string | null;
  has_zh: number;
}
const ELIGIBLE =
  "i.status='done' AND s.item_id IS NOT NULL AND length(trim(s.markdown))>0";
const readyCollections = `SELECT c.id,c.slug,c.title,c.description,c.source_url FROM collection c
  WHERE c.is_public=1 AND EXISTS(SELECT 1 FROM collection_item ci JOIN item i ON i.id=ci.item_id
    JOIN summary s ON s.item_id=i.id WHERE ci.collection_id=c.id AND ${ELIGIBLE}) ORDER BY c.created_at DESC,c.id DESC LIMIT 200`;
export async function publicCollectionsPage(
  env: Env,
  url: URL,
  empty: SeoPage,
): Promise<SeoPage | null> {
  const match = url.pathname.match(/^\/collections(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  let slug: string | undefined;
  try {
    slug = match[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return { ...empty, status: 404 };
  }
  const base =
    ORIGIN + "/collections" + (slug ? "/" + encodeURIComponent(slug) : "");
  let collection: Collection | null = null;
  let entries: Entry[] = [];
  let collections: Collection[] = [];
  if (slug) {
    collection = await env.DB.prepare(
      "SELECT id,slug,title,description,source_url FROM collection WHERE slug=? AND is_public=1",
    )
      .bind(slug)
      .first<Collection>();
    if (!collection)
      return { ...empty, status: 404, body: "<h1>Collection unavailable</h1>" };
    entries = (
      await env.DB.prepare(
        `SELECT i.id,i.title,i.headline,i.subhead,i.author,substr(s.markdown,1,300) markdown,
      CASE WHEN json_valid(t.structured) THEN json_extract(t.structured,'$.headline') END zh_headline,
      CASE WHEN json_valid(t.structured) THEN json_extract(t.structured,'$.subhead') END zh_subhead,
      CASE WHEN t.item_id IS NOT NULL THEN 1 ELSE 0 END has_zh
      FROM collection_item ci JOIN item i ON i.id=ci.item_id JOIN summary s ON s.item_id=i.id
      LEFT JOIN item_translation t ON t.item_id=i.id AND t.lang='zh' AND t.status='done' AND length(trim(t.markdown))>0
      WHERE ci.collection_id=? AND ${ELIGIBLE} ORDER BY ci.position,i.id LIMIT 60`,
      )
        .bind(collection.id)
        .all<Entry>()
    ).results;
  } else {
    collections = (await env.DB.prepare(readyCollections).all<Collection>())
      .results;
  }
  const locale = languagePlan(
    base,
    "en",
    !slug || entries.some((e) => e.has_zh) ? ["zh"] : [],
    url.searchParams.get("lang"),
  );
  const zh = locale.selected === "zh";
  const page: SeoPage = {
    ...empty,
    canonical: locale.canonical,
    language: locale.language,
    alternates: locale.alternates,
    index:
      !locale.missing &&
      (slug ? entries.length > 0 : collections.length > 0) &&
      !["section", "track_id", "view", "offset"].some((k) =>
        url.searchParams.has(k),
      ),
  };
  if (collection) {
    page.title = `${collection.title} ${zh ? "演讲精华与摘要" : "Talk Summaries & Highlights"} | Stream Reducer`;
    page.description = zh
      ? `阅读 ${collection.title} 的精选演讲摘要、技术要点及原始来源。涵盖已完成处理的公开会议视频。`
      : plainText(
          collection.description ||
            `Read source-linked talk summaries from ${collection.title}.`,
        ).slice(0, 180);
    const links = entries.map((e) => {
      const href = `/items/${e.id}${zh && e.has_zh ? "?lang=zh" : ""}`;
      const title = zh && e.zh_headline ? e.zh_headline : e.headline || e.title;
      return {
        href,
        title,
        html: `<article><h2><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></h2><p>${escapeHtml(e.author || "")}</p><p>${escapeHtml(zh && e.zh_subhead ? e.zh_subhead : e.subhead || plainText(e.markdown).slice(0, 180))}</p></article>`,
      };
    });
    page.body = `<nav><a href="/collections${zh ? "?lang=zh" : ""}">${zh ? "会议合集" : "Collections"}</a></nav><h1>${escapeHtml(collection.title)}</h1><p>${escapeHtml(page.description)}</p><p>${zh ? "以下为已可阅读的精选内容；摘要保留原作者归属与来源链接。" : "Explore completed public summaries with creator attribution and links to the original talks."}</p>${links.map((e) => e.html).join("")}`;
    try {
      const source = new URL(collection.source_url);
      if (["https:", "http:"].includes(source.protocol))
        page.body += `<p><a href="${escapeHtml(source.href)}" rel="noopener noreferrer">${zh ? "会议官方资源" : "Official conference resources"}</a></p>`;
    } catch {
      /* Collections without an external source remain readable. */
    }
    page.schema = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: collection.title,
      url: page.canonical,
      inLanguage: page.language,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: links.map((e, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: e.title,
          url: ORIGIN + e.href,
        })),
      },
    };
  } else {
    page.title = `${zh ? "AI 与科技会议演讲合集" : "AI & Technology Conference Summaries"} | Stream Reducer`;
    page.description = zh
      ? "精选 AI、开发者和科技会议的公开演讲，阅读摘要、技术要点和原始来源。"
      : "Explore curated AI, developer and technology conference talks with readable summaries and original sources.";
    page.body =
      `<h1>${zh ? "会议演讲合集" : "Conference talk collections"}</h1><p>${escapeHtml(page.description)}</p>` +
      collections
        .map(
          (c) =>
            `<article><h2><a href="/collections/${encodeURIComponent(c.slug)}${zh ? "?lang=zh" : ""}">${escapeHtml(c.title)}</a></h2>${zh ? "" : `<p>${escapeHtml(c.description)}</p>`}</article>`,
        )
        .join("");
    page.schema = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: page.title,
      url: page.canonical,
      inLanguage: page.language,
    };
  }
  return page;
}
export async function collectionSitemap(env: Env): Promise<string[]> {
  const rows = (await env.DB.prepare(readyCollections).all<Collection>())
    .results;
  // Only collections with actual completed Chinese editions advertise a Chinese URL.
  const translated = (
    await env.DB.prepare(
      `WITH visible AS (
    SELECT ci.collection_id,t.item_id AS translated_id,
      ROW_NUMBER() OVER (PARTITION BY ci.collection_id ORDER BY ci.position,i.id) AS position
    FROM collection_item ci JOIN collection c ON c.id=ci.collection_id
    JOIN item i ON i.id=ci.item_id JOIN summary s ON s.item_id=i.id
    LEFT JOIN item_translation t ON t.item_id=i.id AND t.lang='zh' AND t.status='done' AND length(trim(t.markdown))>0
    WHERE c.is_public=1 AND ${ELIGIBLE})
    SELECT DISTINCT collection_id FROM visible WHERE position<=60 AND translated_id IS NOT NULL`,
    ).all<{ collection_id: number }>()
  ).results;
  const zh = new Set(translated.map((r) => r.collection_id));
  return [
    "/collections",
    "/collections?lang=zh",
    ...rows.flatMap((c) => [
      "/collections/" + encodeURIComponent(c.slug),
      ...(zh.has(c.id)
        ? ["/collections/" + encodeURIComponent(c.slug) + "?lang=zh"]
        : []),
    ]),
  ];
}
