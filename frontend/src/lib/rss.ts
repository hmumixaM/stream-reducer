export interface RssEdition {
  level: string;
  reason: string;
  headline: string;
  intro: string;
  points: string[];
  sections: { title: string; text: string }[];
  summary_covered: boolean;
  based_on_excerpt: boolean;
}
export interface RssSource {
  image_url: string | null;
  site_url: string | null;
  id: number;
  title: string;
  category: string;
  url: string;
  feed_url: string | null;
  folo_id: string | null;
  provider: string;
  actual_provider: string | null;
  last_checked_at: string | null;
  next_poll_at: string;
  lease_until: string | null;
  latest_published_at: string | null;
  connection_label: string | null;
  connection_status: string | null;
  connection_enabled: number | null;
  substack_connection_id?: string | null;
  last_error: string | null;
  earliest_at: string | null;
  backfill_since: string;
  backfill_status: string;
  article_count: number;
  auth_error: number;
  poll_count: number;
  success_count: number;
}
export interface RssArticle {
  id: number;
  url: string;
  title: string;
  author: string | null;
  published_at: string | null;
  completeness: string;
  word_count: number;
  status: string;
  error: string | null;
  source_title: string;
  read_at: string | null;
  saved: number;
  edition: RssEdition | null;
}
export interface RssDetail extends Omit<RssArticle, "edition"> {
  editions: { lang: string; content: RssEdition }[];
  read: { read_at: string | null; saved: number };
  sources: { id: number; title: string; category: string }[];
  extraction_method: string;
  body_version: number;
}
export interface RssBody {
  text: string;
  paragraphs: { id: number; text: string }[];
  completeness: string;
  source_url: string;
  method: string;
  warning: string | null;
}
export interface RssPreview {
  sources: {
    title: string;
    feed_url: string;
    folo_id?: string;
    category: string;
  }[];
  skipped: number;
}
export interface RssStatus {
  enabled: boolean;
  paused: boolean;
  is_admin: boolean;
  folo_available: boolean;
  counts: { status: string; n: number }[];
  backfill_since: string;
}
export async function rssApi<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`/api/rss${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "RSS 暂时不可用，请重试");
  return data as T;
}
export const rssDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString() : "日期未知";
export const completenessLabel = (value: string) =>
  ({
    full: "全文已保存",
    partial: "基于摘录",
    missing: "尚无正文",
    unknown: "等待获取正文",
  })[value] || value;
export const levelLabel = (value: string) =>
  ({
    brief: "短讯",
    article: "文章",
    longform: "长文 / 报告",
    digest: "多主题资讯",
  })[value] || value;
