import type { Env } from "../env";
import type { RssBody, RssEdition } from "./rss";
export interface PublicArticle {
  id: number;
  url: string;
  title: string;
  author: string | null;
  published_at: string | null;
  updated_at: string;
  completeness: string;
  word_count: number;
  body_hash: string;
  body_key: string | null;
  body_version: number;
}
// Select public content explicitly: never serialize jobs, connection data or follows.
export const ARTICLE_FIELDS =
  "a.id,a.url,a.title,a.author,a.published_at,a.updated_at,a.completeness,a.word_count,a.body_hash,a.body_key,a.body_version";
export const ARTICLE_ELIGIBLE =
  "a.status='done' AND EXISTS(SELECT 1 FROM rss_edition e WHERE e.article_id=a.id AND e.body_hash=a.body_hash)";
export async function publicArticle(env: Env, id: number) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const article = await env.DB.prepare(
    `SELECT ${ARTICLE_FIELDS} FROM rss_article a WHERE a.id=? AND ${ARTICLE_ELIGIBLE}`,
  )
    .bind(id)
    .first<PublicArticle>();
  if (!article) return null;
  const editions = await env.DB.prepare(
    "SELECT lang,content FROM rss_edition WHERE article_id=? AND body_hash=? ORDER BY lang",
  )
    .bind(id, article.body_hash)
    .all<{ lang: string; content: string }>();
  return {
    article,
    editions: editions.results.flatMap((e) => {
      try {
        const content = JSON.parse(e.content) as RssEdition;
        return content && typeof content.headline === "string"
          ? [{ lang: e.lang, content }]
          : [];
      } catch {
        return [];
      }
    }),
  };
}
export async function publicArticleBody(
  env: Env,
  article: PublicArticle,
): Promise<RssBody | null> {
  const object = article.body_key
    ? await env.MEDIA.get(article.body_key)
    : null;
  if (!object) return null;
  const body = await object.json<RssBody>();
  // Raw extraction snapshots and account-related upstream metadata stay private.
  return {
    text: body.text,
    paragraphs: body.paragraphs,
    completeness: body.completeness,
    method: body.method,
    word_count: body.word_count,
    source_url: article.url,
  };
}
export async function publicArticleList(
  env: Env,
  q = "",
  offset = 0,
  limit = 24,
) {
  return env.DB.prepare(
    `SELECT a.id,a.url,a.title,a.author,a.published_at FROM rss_article a WHERE ${ARTICLE_ELIGIBLE} ${q ? "AND (a.title LIKE ? OR a.author LIKE ?)" : ""} ORDER BY a.published_at DESC,a.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...(q ? [`%${q}%`, `%${q}%`] : []), limit, offset)
    .all<{
      id: number;
      url: string;
      title: string;
      author: string;
      published_at: string;
    }>();
}
