import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, resolveUser, type AppContext } from "../auth";
import { all } from "../db";
import { deriveChannelIdentity, resolveChannelIdentity, upsertChannel } from "../lib/channels";
import { followRss, rssCall, type RssSource } from "../lib/rss";
import { readJson } from "../lib/request";
import { followKnownChannel } from "./channels";
import {
  discoverSources, displayPlatform, feedUrl, PROVIDERS, SOURCE_PLATFORMS, sourceAliases,
  type DiscoveryProvider, type PublicSource, type SourceSearchResult,
} from "../lib/sourceDiscovery";

export const sourceRoutes = new Hono<AppContext>();
sourceRoutes.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  // Do not expose upstream responses or credentials in user-facing errors.
  console.warn("source_request_failed", { path: c.req.path });
  return c.json({ error: "来源暂时不可用，请重试或通过链接添加" }, 502);
});

interface CatalogRow {
  access?: "free" | "paid" | "unknown";
  id: number; kind: "media" | "article"; stored_platform: string; title: string | null;
  url: string; feed_url: string | null; image_url: string | null; following: number; folo_id: string | null;
}
function catalogSql(includeArticles: boolean): string {
  return `SELECT ch.id,'media' kind,ch.platform stored_platform,ch.title,
    COALESCE(ch.source_url,ch.feed_url) url,ch.feed_url,ch.image_url,
    EXISTS(SELECT 1 FROM subscription s WHERE s.channel_id=ch.id AND s.user_id=?) following,NULL folo_id,NULL access
    ,ch.channel_key identity_key FROM channel ch ${includeArticles ? `UNION ALL SELECT r.id,'article' kind,CASE WHEN r.provider='substack' THEN 'substack' ELSE 'article' END stored_platform,r.title,
    r.url,COALESCE(r.feed_url,CASE WHEN r.substack_subdomain IS NOT NULL THEN 'https://'||r.substack_subdomain||'.substack.com/feed' END) feed_url,r.image_url,EXISTS(SELECT 1 FROM rss_follow f WHERE f.source_id=r.id AND f.user_id=?) following,r.folo_id,r.substack_access access
    ,r.identity identity_key FROM rss_source r` : ""}`;
}
export function catalogResult(row: CatalogRow): SourceSearchResult {
  const platform = displayPlatform(row.url, row.feed_url, row.stored_platform);
  const aliases = sourceAliases(platform, row.url, row.feed_url);
  if (row.folo_id) aliases.push(`folo:${row.folo_id}`);
  return {
    key: `${row.kind}:${row.id}`, provider: "known", provider_id: String(row.id), kind: row.kind, platform,
    title: row.title || row.url, image_url: row.image_url, description: null, url: row.url, feed_url: row.feed_url,
    aliases, channel_id: row.kind === "media" ? row.id : null, rss_source_id: row.kind === "article" ? row.id : null,
    following: Boolean(row.following), ...(platform === "substack" ? { access: row.access || "unknown" } : {}),
  };
}
async function matchingCatalog(c: Parameters<typeof requireAuth>[0], userId: number, rows: PublicSource[]): Promise<SourceSearchResult[]> {
  if (!rows.length) return [];
  const keys = [...new Set(rows.flatMap(r => [r.url, r.feed_url, r.provider_id, ...r.aliases.flatMap(a => [a, a.slice(a.indexOf(":") + 1)])]).filter((v): v is string => Boolean(v)))];
  return (await all<CatalogRow>(c.env.DB.prepare(`WITH lookup(value) AS (VALUES ${keys.map(() => "(?)").join(",")})
    SELECT * FROM (${catalogSql(true)}) WHERE url IN (SELECT value FROM lookup)
    OR feed_url IN (SELECT value FROM lookup) OR folo_id IN (SELECT value FROM lookup) OR identity_key IN (SELECT value FROM lookup)`)
    .bind(...keys, userId, userId))).map(catalogResult);
}
async function knownById(c: Parameters<typeof requireAuth>[0], userId: number, kind: "media" | "article", id: number) {
  const row = await c.env.DB.prepare(`SELECT * FROM (${catalogSql(true)}) WHERE kind=? AND id=?`).bind(userId, userId, kind, id).first<CatalogRow>();
  return row ? catalogResult(row) : null;
}
export function hydrateSources(rows: PublicSource[], known: SourceSearchResult[]): SourceSearchResult[] {
  return rows.map(row => {
    const match = known.find(k => (row.kind !== "media" || k.kind === "media") && k.aliases.some(a => row.aliases.includes(a)));
    return { ...row, key: match?.key || `${row.provider}:${row.provider_id}`, channel_id: match?.channel_id ?? null,
      kind: match?.kind ?? row.kind,
      rss_source_id: match?.rss_source_id ?? null, following: match?.following ?? false,
      aliases: [...new Set([...row.aliases, ...(match?.aliases || [])])] };
  });
}
const integer = (raw: string | undefined, fallback: number, max: number) => raw && /^\d+$/.test(raw) ? Math.min(Number(raw), max) : fallback;
sourceRoutes.get("/search", async c => {
  const user = await resolveUser(c.env, c);
  const provider = c.req.query("provider") || "known";
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const platform = c.req.query("platform") || "";
  if (platform && !SOURCE_PLATFORMS.includes(platform as any)) return c.json({ error: "未知平台" }, 400);
  if (provider !== "known" && !PROVIDERS.includes(provider as DiscoveryProvider)) return c.json({ error: "未知搜索渠道" }, 400);
  if (provider !== "known" && !user) return c.json({ error: "请登录后搜索外部来源" }, 401);
  c.header("Cache-Control", "private, no-store");
  if (provider === "known") {
    // Classify legacy RSS podcast rows before filtering and paginate in D1.
    const offset = integer(c.req.query("offset"), 0, 1_000_000), limit = Math.max(1, integer(c.req.query("limit"), 24, 50));
    const clauses: string[] = ["(display_platform!='substack' OR access='free')"], binds: unknown[] = user ? [user.id, user.id] : [-1];
    if (q) { clauses.push("instr(lower(COALESCE(title,'') || ' ' || url || ' ' || COALESCE(feed_url,'')),lower(?))>0"); binds.push(q); }
    if (platform) { clauses.push(platform === "article" ? "kind='article'" : "display_platform=?"); if (platform !== "article") binds.push(platform); }
    const rows = await all<CatalogRow>(c.env.DB.prepare(`WITH public_catalog AS (${catalogSql(Boolean(user))}), classified AS (
      SELECT *, CASE
        WHEN stored_platform='substack' OR url GLOB 'https://*.substack.com*' OR feed_url GLOB 'https://*.substack.com/*' THEN 'substack'
        WHEN url LIKE 'https://www.youtube.com/%' OR url LIKE 'https://youtube.com/%' OR feed_url LIKE '%/youtube/channel/%' THEN 'youtube'
        WHEN url LIKE 'https://space.bilibili.com/%' OR feed_url LIKE '%/bilibili/user/video/%' THEN 'bilibili'
        WHEN url LIKE 'https://podcasts.apple.com/%' OR url LIKE 'https://itunes.apple.com/%' THEN 'apple_podcast'
        WHEN url LIKE 'https://www.xiaoyuzhoufm.com/%' OR url LIKE 'https://xiaoyuzhoufm.com/%' OR feed_url LIKE '%/xiaoyuzhou/podcast/%' THEN 'xiaoyuzhou'
        ELSE stored_platform END display_platform FROM public_catalog)
      SELECT * FROM classified ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY following DESC, COALESCE(NULLIF(title,''),url) COLLATE NOCASE, kind, id LIMIT ? OFFSET ?`)
      .bind(...binds, limit + 1, offset));
    return c.json({ results: rows.slice(0, limit).map(catalogResult), next_offset: rows.length > limit ? offset + limit : null });
  }
  if (!q) return c.json({ results: [], next_offset: null });
  try {
    const rows = (await discoverSources(c.env, provider as DiscoveryProvider, q)).filter(r => !platform || r.platform === platform || (platform === "article" && r.kind === "article")).slice(0, 10);
    return c.json({ results: hydrateSources(rows, await matchingCatalog(c, user!.id, rows)), next_offset: null });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "搜索暂时不可用" }, 502);
  }
});

sourceRoutes.post("/follow", requireAuth, async c => {
  const body = await readJson<{ provider?: string; provider_id?: string; q?: string; channel_id?: number; rss_source_id?: number }>(c);
  const userId = c.get("user").id;
  const validId = (id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0;
  let result: SourceSearchResult;
  if (body.provider === "known") {
    if (validId(body.channel_id) === validId(body.rss_source_id)) return c.json({ error: "请选择一个来源" }, 400);
    const row = await knownById(c, userId, validId(body.channel_id) ? "media" : "article", body.channel_id || body.rss_source_id!);
    if (!row) return c.json({ error: "来源不存在" }, 404);
    result = row;
  } else {
    if (!PROVIDERS.includes(body.provider as DiscoveryProvider) || typeof body.provider_id !== "string" || typeof body.q !== "string" || !body.q.trim() || body.q.length > 100) {
      return c.json({ error: "请重新搜索后关注来源" }, 400);
    }
    const rows = await discoverSources(c.env, body.provider as DiscoveryProvider, body.q.trim());
    const selected = rows.find(r => r.provider_id === body.provider_id);
    if (!selected) return c.json({ error: "来源已不在搜索结果中，请重新搜索" }, 409);
    result = hydrateSources([selected], await matchingCatalog(c, userId, [selected]))[0];
  }
  try {
    if (result.channel_id) {
      await followKnownChannel(c.env, userId, result.channel_id);
    } else if (result.rss_source_id) {
      const row = await c.env.DB.prepare("SELECT * FROM rss_source WHERE id=?").bind(result.rss_source_id).first<RssSource>();
      if (!row) return c.json({ error: "来源不存在" }, 404);
      await followRss(c.env, userId, row);
      await c.env.RSS_JOBS.send({ kind: "rss_poll", source_id: row.id });
    } else {
      // Resolve/inspect the feed on the server. In particular a podcast found
      // through Folo must never be silently subscribed to the article pipeline.
      let resolved: Record<string, any> | undefined;
      if (result.provider === "substack") {
        resolved = await rssCall<Record<string, any>>(c.env, "/substack/resolve", { url: result.url });
        if (resolved.access !== "free") return c.json({ error: resolved.access === "paid" ? "需要付费，暂时无法订阅此 Substack 刊物" : "无法确认刊物免费，暂时无法订阅" }, 403);
        const feed = `https://${resolved.substack_subdomain}.substack.com/feed`;
        resolved = { ...resolved, identity: `feed:${feed}`, feed_url: feed };
      }
      if (result.provider === "folo" && !["youtube", "bilibili"].includes(result.platform)) {
        resolved = await rssCall<Record<string, any>>(c.env, "/source-inspect", { url: `https://app.folo.is/feed/${result.provider_id}`, token: c.env.FOLO_TOKEN || "" });
        if (resolved.kind === "media") result.kind = "media";
        if (result.kind === "media" && !resolved.feed_url) throw new Error("节目没有可轮询的公开 feed");
      }
      if (result.kind === "media") {
        const address = feedUrl(resolved?.feed_url || result.feed_url, c.env);
        if (!address) throw new Error("节目没有可轮询的公开 feed");
        if (result.platform === "article") result.platform = displayPlatform(result.url, address, "rss");
        const identity = ["youtube", "bilibili"].includes(result.platform)
          ? await resolveChannelIdentity(result.url) : deriveChannelIdentity(result.url, address);
        const channel = await upsertChannel(c.env, identity, { title: result.title, imageUrl: result.image_url });
        result.channel_id = channel.id;
        result.key = `media:${channel.id}`;
        await followKnownChannel(c.env, userId, channel.id);
      } else {
        if (!resolved) throw new Error("来源需要重新解析");
        const id = await followRss(c.env, userId, resolved);
        result.rss_source_id = id;
        result.key = `article:${id}`;
        await c.env.RSS_JOBS.send({ kind: "rss_poll", source_id: id });
      }
    }
    return c.json({ ...result, following: true });
  } catch (error) {
    console.warn("source_follow_failed", { provider: result.provider, kind: result.kind });
    if (error instanceof HTTPException) throw error;
    return c.json({ error: "关注未完成，请重试；节目来源需要可访问的公开 feed" }, 502);
  }
});
