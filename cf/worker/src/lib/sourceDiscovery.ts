import type { Env } from "../env";
import { normalizeChannelUrl } from "./channels";
import { sha256 } from "./crypto";
import { rssCall } from "./rss";

export type DiscoveryProvider = "youtube" | "bilibili" | "apple_podcast" | "folo" | "substack";
export type SourcePlatform = "youtube" | "bilibili" | "apple_podcast" | "xiaoyuzhou" | "rss" | "article" | "substack";
export interface PublicSource {
  provider: DiscoveryProvider | "known";
  provider_id: string;
  kind: "media" | "article";
  platform: SourcePlatform;
  title: string;
  image_url: string | null;
  description: string | null;
  url: string;
  feed_url: string | null;
  aliases: string[];
  access?: "free" | "paid" | "unknown";
}
export interface SourceSearchResult extends PublicSource {
  key: string;
  channel_id: number | null;
  rss_source_id: number | null;
  following: boolean;
}
export const PROVIDERS: DiscoveryProvider[] = ["youtube", "bilibili", "apple_podcast", "folo", "substack"];
export const SOURCE_PLATFORMS: SourcePlatform[] = ["youtube", "bilibili", "apple_podcast", "xiaoyuzhou", "rss", "article", "substack"];

const text = (value: unknown, max = 500): string => typeof value === "string"
  ? value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim().slice(0, max) : "";
export function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
    return normalizeChannelUrl(u.toString());
  } catch { return null; }
}
export function feedUrl(raw: unknown, env: Pick<Env, "RSSHUB_BASE_URL">): string | null {
  if (typeof raw === "string" && raw.startsWith("rsshub://")) {
    return httpUrl(`${env.RSSHUB_BASE_URL || "https://rsshub.app"}/${raw.slice(9)}`);
  }
  return httpUrl(raw);
}
export function displayPlatform(url: string, feed: string | null, stored = "rss"): SourcePlatform {
  for (const raw of [url, feed]) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (/(^|\.)substack\.com$/.test(u.hostname) && u.hostname !== "substack.com") return "substack";
      if (/(^|\.)youtube\.com$/.test(u.hostname)) return "youtube";
      if (/(^|\.)bilibili\.com$/.test(u.hostname)) return "bilibili";
      if (/(^|\.)(podcasts|itunes)\.apple\.com$/.test(u.hostname)) return "apple_podcast";
      if (/(^|\.)xiaoyuzhoufm\.com$/.test(u.hostname) || /\/xiaoyuzhou\/podcast\/[a-f\d]{24}/i.test(u.pathname)) return "xiaoyuzhou";
      if (/\/youtube\/channel\/UC[\w-]{22}/.test(u.pathname)) return "youtube";
      if (/\/bilibili\/user\/video\/\d+/.test(u.pathname)) return "bilibili";
    } catch { /* Non-HTTP RSSHub identifiers are inspected below. */ }
    if (/^rsshub:\/\/xiaoyuzhou\/podcast\/[a-f\d]{24}/i.test(raw)) return "xiaoyuzhou";
  }
  return SOURCE_PLATFORMS.includes(stored as SourcePlatform) ? stored as SourcePlatform : "rss";
}
export function sourceAliases(platform: SourcePlatform, url: string, feed: string | null, id?: string): string[] {
  const aliases: string[] = [];
  if (platform === "youtube") {
    const channel = id?.match(/^UC[\w-]{22}$/)?.[0] || url.match(/\/channel\/(UC[\w-]{22})/)?.[1]
      || (feed ? new URL(feed).searchParams.get("channel_id") : null);
    if (channel) aliases.push(`youtube:${channel}`);
  }
  if (platform === "bilibili") {
    const mid = id?.match(/^\d+$/)?.[0] || url.match(/space\.bilibili\.com\/(\d+)/)?.[1];
    if (mid) aliases.push(`bilibili:${mid}`);
  }
  for (const raw of [url, feed]) {
    const pid = raw?.match(/(?:xiaoyuzhoufm\.com|xiaoyuzhou)\/(?:podcast)\/([a-f\d]{24})/i)?.[1];
    if (pid) aliases.push(`xiaoyuzhou:${pid.toLowerCase()}`);
  }
  if (feed) aliases.push(`feed:${normalizeChannelUrl(feed)}`);
  aliases.push(`url:${normalizeChannelUrl(url)}`);
  return [...new Set(aliases)];
}
function source(provider: DiscoveryProvider, id: string, platform: SourcePlatform, url: string, feed: string | null,
  title: unknown, image: unknown, description: unknown, kind: "media" | "article" = "media"): PublicSource {
  return { provider, provider_id: id, kind, platform, url, feed_url: feed, title: text(title, 200) || url,
    image_url: httpUrl(image), description: text(description) || null, aliases: sourceAliases(platform, url, feed, id) };
}

// Extract JSON using balanced braces: regex alone breaks on nested renderers or
// braces in channel descriptions. Only channelRenderer nodes are accepted.
export function parseYoutube(html: string): PublicSource[] {
  const match = /(?:var\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=|ytInitialData\s*=)\s*/.exec(html);
  if (!match) throw new Error("YouTube 未返回频道搜索数据");
  const start = html.indexOf("{", match.index + match[0].length);
  let depth = 0, quoted = false, escaped = false, end = start;
  for (; end < html.length; end++) {
    const c = html[end];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
  }
  const data: unknown = JSON.parse(html.slice(start, end + 1));
  const rows: PublicSource[] = [];
  const renderedText = (v: any) => v?.simpleText || v?.runs?.map((r: any) => r.text).join("") || "";
  function walk(v: any) {
    if (!v || typeof v !== "object") return;
    const ch = v.channelRenderer;
    if (ch && /^UC[\w-]{22}$/.test(ch.channelId)) {
      rows.push(source("youtube", ch.channelId, "youtube", `https://www.youtube.com/channel/${ch.channelId}`,
        `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.channelId}`, renderedText(ch.title),
        ch.thumbnail?.thumbnails?.at(-1)?.url, renderedText(ch.descriptionSnippet)));
    }
    for (const child of Object.values(v)) walk(child);
  }
  walk(data);
  return rows;
}
export function parseBilibili(data: any): PublicSource[] {
  if (data.code !== 0 || !data.data) throw new Error("B 站搜索暂时不可用");
  return (data.data.result || []).filter((r: any) => /^\d+$/.test(String(r.mid))).map((r: any) =>
    source("bilibili", String(r.mid), "bilibili", `https://space.bilibili.com/${r.mid}`,
      `https://space.bilibili.com/${r.mid}`, r.uname, r.upic, r.usign));
}
export function parseApple(data: any): PublicSource[] {
  if (!Array.isArray(data.results)) throw new Error("Apple Podcasts 未返回节目数据");
  return data.results.filter((r: any) => r.kind === "podcast" && /^\d+$/.test(String(r.collectionId)) && httpUrl(r.feedUrl))
    .map((r: any) => source("apple_podcast", String(r.collectionId), "apple_podcast",
      httpUrl(r.collectionViewUrl) || `https://podcasts.apple.com/podcast/id${r.collectionId}`, httpUrl(r.feedUrl),
      r.collectionName, r.artworkUrl600 || r.artworkUrl100, r.artistName));
}
export function parseFolo(data: any, env: Pick<Env, "RSSHUB_BASE_URL">): PublicSource[] {
  if (!Array.isArray(data.data)) throw new Error("Folo 未返回公开来源数据");
  return data.data.flatMap((row: any) => {
    const f = row.feed;
    if (!f || f.isPrivate || !/^\d+$/.test(String(f.id))) return [];
    const feed = feedUrl(f.url, env);
    if (!feed) return [];
    const site = httpUrl(f.siteUrl);
    let platform = displayPlatform(site || feed, f.url, "article");
    if (platform === "substack") return []; // Use verified Substack discovery for payment eligibility.
    const media = platform !== "article" || row.entries?.some((e: any) =>
      [...(Array.isArray(e.media) ? e.media : []), ...(Array.isArray(e.attachments) ? e.attachments : [])]
        .some((m: any) => /^(audio|video)(\/|$)/.test(m.type || m.mime_type || "")));
    if (media && platform === "article") platform = "rss";
    let url = platform === "xiaoyuzhou"
      ? `https://www.xiaoyuzhoufm.com/podcast/${(site || f.url).match(/\/podcast\/([a-f\d]{24})/i)?.[1] || f.url.match(/\/podcast\/([a-f\d]{24})/i)?.[1]}`
      : platform === "youtube" || platform === "bilibili" || platform === "apple_podcast" ? site || feed : `https://app.folo.is/feed/${f.id}`;
    const yt = `${site || ""} ${f.url}`.match(/(?:\/channel\/|channel_id=)(UC[\w-]{22})/);
    if (platform === "youtube" && yt) url = `https://www.youtube.com/channel/${yt[1]}`;
    const bili = `${site || ""} ${f.url}`.match(/(?:space\.bilibili\.com\/|\/bilibili\/user\/video\/)(\d+)/);
    if (platform === "bilibili" && bili) url = `https://space.bilibili.com/${bili[1]}`;
    const result = source("folo", String(f.id), platform, url, feed, f.title, f.image, f.description, media ? "media" : "article");
    result.aliases.push(`folo:${f.id}`);
    return [result];
  });
}

export function substackAccess(publication: any): "free" | "paid" | "unknown" {
  if (publication?.payments_state === "enabled" || publication?.plans?.some((p: any) => Number(p.amount) > 0)) return "paid";
  return ["disabled", "never_enabled"].includes(publication?.payments_state) ? "free" : "unknown";
}
export function parseSubstack(data: any): PublicSource[] {
  // The website's Publications endpoint currently returns empty even for known
  // names. Its Top search includes canonical publication metadata for matches.
  const publications = Array.isArray(data.items) ? data.items.flatMap((item: any) => [
    item.publication, ...(item.context?.users || []).map((user: any) => user.primary_publication),
  ]).filter(Boolean) : data.results;
  if (!Array.isArray(publications)) throw new Error("Substack 未返回刊物搜索数据");
  return [...new Map(publications.map((p: any) => [p.id, p])).values()].flatMap((p: any) => {
    if (!/^\d+$/.test(String(p.id)) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p.subdomain) || substackAccess(p) !== "free") return [];
    const origin = `https://${p.subdomain}.substack.com`;
    const row = source("substack", String(p.id), "substack", origin, `${origin}/feed`, p.name, p.logo_url, p.description, "article");
    row.aliases.push(`substack:${p.id}`);
    return [{ ...row, access: "free" as const }];
  });
}

export function searchRequest(provider: DiscoveryProvider, q: string, token?: string): { url: string; init?: RequestInit } {
  if (provider === "youtube") return { url: `https://www.youtube.com/results?${new URLSearchParams({ search_query: q, sp: "EgIQAg==" })}` };
  if (provider === "bilibili") return {
    url: `https://api.bilibili.com/x/web-interface/search/type?${new URLSearchParams({ search_type: "bili_user", keyword: q, page: "1" })}`,
    init: { headers: { Referer: "https://search.bilibili.com/", Cookie: `buvid3=${crypto.randomUUID().toUpperCase()}infoc;` } },
  };
  if (provider === "apple_podcast") return { url: `https://itunes.apple.com/search?${new URLSearchParams({ term: q, entity: "podcast", limit: "10" })}` };
  if (provider === "substack") return { url: `https://substack.com/api/v1/top/search?${new URLSearchParams({ query: q, fromSuggestedSearch: "false" })}` };
  if (!token) throw new Error("Folo 搜索尚未连接");
  return { url: "https://api.folo.is/discover", init: { method: "POST", headers: {
    "content-type": "application/json", Authorization: `Bearer ${token}`,
    Cookie: `__Secure-better-auth.session_token=${token}; better-auth.session_token=${token}`,
  }, body: JSON.stringify({ keyword: q, target: "feeds" }) } };
}

export async function discoverSources(env: Env, provider: DiscoveryProvider, q: string): Promise<PublicSource[]> {
  const started = Date.now();
  const cacheKey = new Request(`https://source-discovery.internal/v1/${provider}/${await sha256(`${env.RSSHUB_BASE_URL || ""}:${q.toLowerCase()}`)}`);
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const cached = await cache?.match(cacheKey).catch(() => undefined);
  if (cached) {
    try { return await cached.json<PublicSource[]>(); } catch { /* Ignore a malformed cache entry. */ }
  }
  const request = searchRequest(provider, q, env.FOLO_TOKEN);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(new Error("搜索超时"));
    else controller.signal.addEventListener("abort", () => reject(new Error("搜索超时")), { once: true });
  })]);
  try {
    let raw: string;
    try {
      const direct = new AbortController();
      const directTimeout = setTimeout(() => direct.abort(), 4000);
      try {
        const response = await bounded(fetch(request.url, { ...request.init, redirect: "error", signal: direct.signal, headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "accept-language": "en-US,en;q=0.8", ...request.init?.headers,
        } }));
        if (!response.ok) throw new Error(`upstream ${response.status}`);
        raw = await bounded(response.text());
        if (raw.length > 4_000_000) throw new Error("search response too large");
        if (provider === "bilibili" && JSON.parse(raw).code !== 0) throw new Error("upstream blocked");
        if (provider === "youtube" && !raw.includes("ytInitialData")) throw new Error("upstream blocked");
      } finally { clearTimeout(directTimeout); }
    } catch {
      if (controller.signal.aborted) throw new Error("搜索超时，请重试");
      // The container receives a provider enum and keyword, never a target URL.
      raw = await bounded(rssCall<{ body: string }>(env, "/source-search", { provider, q, token: provider === "folo" ? env.FOLO_TOKEN : "" }, 0, controller.signal)).then(r => r.body);
    }
    const parsed = provider === "youtube" ? parseYoutube(raw) : provider === "bilibili" ? parseBilibili(JSON.parse(raw))
      : provider === "apple_podcast" ? parseApple(JSON.parse(raw)) : provider === "substack" ? parseSubstack(JSON.parse(raw)) : parseFolo(JSON.parse(raw), env);
    // Keep a bounded candidate page so platform filtering can happen before
    // the API's ten-row limit, and follow can revalidate any displayed result.
    const rows = [...new Map(parsed.map(r => [r.provider_id, r])).values()].slice(0, 100);
    try {
      await cache?.put(cacheKey, new Response(JSON.stringify(rows), { headers: { "content-type": "application/json", "cache-control": "max-age=600" } }));
    } catch { /* A cache failure must not hide valid search results. */ }
    console.info("source_search", { provider, elapsed_ms: Date.now() - started, count: rows.length });
    return rows;
  } catch {
    console.warn("source_search_failed", { provider, reason: controller.signal.aborted ? "timeout" : "upstream", elapsed_ms: Date.now() - started });
    throw new Error(controller.signal.aborted ? "搜索超时，请重试" : `${provider === "folo" ? "Folo 搜索不可用，请检查服务端连接" : "平台搜索暂时不可用"}，可重试或通过链接添加`);
  } finally { clearTimeout(timeout); }
}
