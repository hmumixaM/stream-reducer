import type { Env } from "../env";
import type { RssEdition } from "./rss";

export type FeedCursor = [number, number, number];
export function feedCursorFilter(
  date: string,
  id: string,
  kind: number,
  cursor?: FeedCursor,
) {
  return cursor
    ? {
        sql: ` AND (${date} < ? OR (${date} = ? AND (? > ${kind} OR (? = ${kind} AND ${id} < ?))))`,
        binds: [cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]],
      }
    : { sql: "", binds: [] };
}

export async function rssBulletins(
  env: Env,
  userId: number,
  language: string,
  params: Record<string, string>,
  count: number,
  cursor?: FeedCursor,
) {
  if (params.platform && params.platform !== "article") return [];
  const sort = "COALESCE(julianday(a.published_at),julianday(a.created_at),0)";
  const after = feedCursorFilter(sort, "a.id", 1, cursor);
  const args: unknown[] = [
    language === "zh" ? "zh" : "original",
    userId,
    userId,
    ...after.binds,
  ];
  let filters = after.sql;
  if (params.saved === "true") filters += " AND r.saved=1";
  if (params.source) {
    const id = Number(params.source);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid source");
    filters += " AND s.id=?";
    args.push(id);
  }
  if (params.q?.trim()) {
    filters +=
      " AND (a.title LIKE ? OR a.author LIKE ? OR s.title LIKE ? OR json_extract(COALESCE(p.content,o.content),'$.headline') LIKE ?)";
    const q = `%${params.q.trim().slice(0, 200)}%`;
    args.push(q, q, q, q);
  }
  const rows = await env.DB.prepare(
    `SELECT a.id,a.title,a.author,a.url,a.published_at,a.created_at,${sort} sort_date,
    MAX(COALESCE(r.saved,0)) saved,GROUP_CONCAT(DISTINCT s.title) source_title,
    CASE WHEN p.content IS NOT NULL THEN p.lang ELSE o.lang END edition_lang,
    json_object('headline',json_extract(COALESCE(p.content,o.content),'$.headline'),
      'intro',json_extract(COALESCE(p.content,o.content),'$.intro'),
      'points',json_extract(COALESCE(p.content,o.content),'$.points'),
      'based_on_excerpt',json_extract(COALESCE(p.content,o.content),'$.based_on_excerpt')) edition
    FROM rss_article a JOIN rss_source_article sa ON sa.article_id=a.id
    JOIN rss_source s ON s.id=sa.source_id JOIN rss_follow f ON f.source_id=s.id
    JOIN rss_edition o ON o.article_id=a.id AND o.lang='original' AND o.body_hash=a.body_hash
    LEFT JOIN rss_edition p ON p.article_id=a.id AND p.lang=? AND p.body_hash=a.body_hash
    LEFT JOIN rss_read r ON r.article_id=a.id AND r.user_id=?
    WHERE f.user_id=? AND a.status='done' ${filters}
    GROUP BY a.id ORDER BY ${sort} DESC,a.id DESC LIMIT ?`,
  )
    .bind(...args, count)
    .all<{
      id: number;
      title: string;
      author: string | null;
      url: string;
      published_at: string | null;
      created_at: string;
      sort_date: number;
      saved: number;
      source_title: string;
      edition: string;
      edition_lang: string;
    }>();
  return rows.results.map((row) => {
    const e = JSON.parse(row.edition) as RssEdition;
    const points = (e.points || []).map((text) => ({ text, timestamp: null }));
    return {
      sort_date: row.sort_date,
      rank: 1,
      item: {
        id: row.id,
        content_type: "article" as const,
        title: e.headline || row.title,
        source_title: row.title,
        subhead: null,
        author: row.source_title || row.author,
        platform: "article",
        source_url: row.url,
        duration_s: null,
        published_at: row.published_at,
        created_at: row.created_at,
        saved: !!row.saved,
        bulletin: points.map((p) => p.text),
        bulletin_points: points,
        bulletin_language:
          row.edition_lang === "zh" ? ("zh" as const) : ("original" as const),
        bulletin_overview: e.intro || "",
        bulletin_intro_ready: true,
        localization_status:
          language === "zh" && row.edition_lang !== "zh" ? "missing" : "done",
        summary: e.intro || "",
        based_on_excerpt: !!e.based_on_excerpt,
      },
    };
  });
}
