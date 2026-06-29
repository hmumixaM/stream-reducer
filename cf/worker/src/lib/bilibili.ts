// Bilibili subscription sources. Bilibili has no native RSS, so we build feed
// entries from its web JSON APIs. Three kinds are supported:
//   - space   : an UP主's recent video uploads (via the web-dynamic feed, which
//               isn't as aggressively risk-controlled as space/arc/search)
//   - season  : a 合集 (collection) playlist
//   - series  : a 系列 playlist
// The season/space APIs require a logged-in cookie to pass risk control
// (BILIBILI_COOKIE secret); series works without one.
import type { Env } from "../env";
import { parseDuration, type FeedEntry } from "./feed";
import { getBilibiliCookie } from "./biliAuth";

export interface BiliSource {
  kind: "space" | "season" | "series";
  mid: string;
  sid?: string; // season_id / series_id
  // 合集 (season) and 系列 (series) share the modern /lists/<sid> URL shape but
  // live in SEPARATE sid namespaces, so the same number resolves to two
  // unrelated lists. When the URL didn't disambiguate via ?type=, this carries
  // the other list kind to try if the primary one yields no videos.
  fallbackKind?: "season" | "series";
}

// Parse a bilibili space / playlist URL into a feed source descriptor.
export function parseBilibiliUrl(input: string): BiliSource | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!url.hostname.toLowerCase().endsWith("space.bilibili.com")) return null;

  const mid = url.pathname.split("/").filter(Boolean)[0];
  if (!mid || !/^\d+$/.test(mid)) return null;

  // Modern unified UI: /<mid>/lists/<sid> or /<mid>/lists?sid=<sid>, optionally
  // disambiguated by ?type=season|series. A bare /lists/<sid> (no type) is
  // ambiguous, so default to season and keep series as a fallback.
  const listsMatch = url.pathname.match(/^\/\d+\/lists(?:\/(\d+))?/);
  if (listsMatch) {
    const sid = listsMatch[1] || url.searchParams.get("sid") || "";
    if (sid) {
      const type = (url.searchParams.get("type") || "").toLowerCase();
      if (type === "series") return { kind: "series", mid, sid, fallbackKind: "season" };
      return { kind: "season", mid, sid, fallbackKind: "series" };
    }
  }
  // Legacy playlist URLs carry an explicit kind, so no fallback is needed.
  if (url.pathname.includes("/channel/collectiondetail")) {
    const sid = url.searchParams.get("sid");
    if (sid) return { kind: "season", mid, sid };
  }
  if (url.pathname.includes("/channel/seriesdetail")) {
    const sid = url.searchParams.get("sid");
    if (sid) return { kind: "series", mid, sid };
  }
  // Bare space (optionally /video, /dynamic, …) -> the UP主's uploads.
  return { kind: "space", mid };
}

// True when the URL points at a Bilibili 合集/系列 (an expandable list), as
// opposed to a single video or a bare UP主 space (channel). Used by the add
// validation + expansion: lists are addable directly (they expand into their
// videos), but a bare channel belongs in a subscription.
export function isBilibiliListUrl(input: string): boolean {
  const src = parseBilibiliUrl(input);
  return src !== null && src.kind !== "space";
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface BiliDynamicArchive {
  bvid?: string | number;
  title?: string | null;
  duration_text?: string | null;
}

interface BiliDynamicItem {
  modules?: {
    module_dynamic?: {
      major?: {
        archive?: BiliDynamicArchive;
      };
    };
    module_author?: {
      pub_ts?: string | number | null;
    };
  };
}

interface BiliDynamicResponse {
  data?: {
    items?: BiliDynamicItem[];
  };
}

async function biliGet<T>(url: string, referer: string, cookie: string | undefined): Promise<T> {
  const headers: Record<string, string> = { "user-agent": UA, referer };
  if (cookie) headers["cookie"] = cookie;
  const res = await fetch(url, { headers });
  // Bilibili risk-controls the Worker's Cloudflare egress IP by serving an HTML
  // challenge page instead of JSON; surface a clear reason rather than letting
  // JSON.parse throw a cryptic "Unexpected token '<'".
  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    const hint = body.trimStart().startsWith("<") ? " — likely IP risk control" : "";
    throw new Error(`Bilibili returned a non-JSON response (HTTP ${res.status})${hint}`);
  }
}

function videoEntry(bvid: string, title: string, tsSeconds: number | null, duration?: string | number | null): FeedEntry {
  return {
    title,
    link: `https://www.bilibili.com/video/${bvid}`,
    guid: bvid,
    published: tsSeconds ? new Date(tsSeconds * 1000).toISOString() : null,
    audio: null,
    duration_s: parseDuration(duration),
  };
}

// Enumerate a 合集 (season) or 系列 (series) list via the container's yt-dlp,
// which egresses through WARP with the login cookie. The Worker's own calls to
// Bilibili's list APIs get risk-controlled (HTML challenge) from Cloudflare IPs,
// so this is the reliable path (it's the same one that downloads the videos).
// A bare /lists/<sid> URL can't tell a 合集 from a 系列 — they share the sid
// shape but live in separate namespaces — so try the URL's kind, then the other.
async function fetchBilibiliListEntries(env: Env, src: BiliSource): Promise<FeedEntry[]> {
  if (!src.sid) return [];
  const { fetchFeedEntries } = await import("../pipeline/container");
  const kinds: ("season" | "series")[] = [];
  if (src.kind === "season" || src.kind === "series") kinds.push(src.kind);
  if (src.fallbackKind) kinds.push(src.fallbackKind);

  let lastError: unknown = null;
  for (const kind of kinds) {
    const detail = kind === "series" ? "seriesdetail" : "collectiondetail";
    const listUrl = `https://space.bilibili.com/${src.mid}/channel/${detail}?sid=${src.sid}`;
    let raw: Awaited<ReturnType<typeof fetchFeedEntries>>;
    try {
      raw = await fetchFeedEntries(env, listUrl);
    } catch (err) {
      lastError = err; // wrong list kind / transient — try the other
      continue;
    }
    const entries = raw
      .filter((entry) => entry.external_id)
      .map((entry): FeedEntry => ({
        title: entry.title,
        link: `https://www.bilibili.com/video/${entry.external_id}`,
        guid: entry.external_id,
        published: entry.published,
        audio: null,
        duration_s: entry.duration_s,
      }));
    if (entries.length) return entries;
  }
  // No entries from any candidate. Surface the real extractor failure (so the
  // poll/add error isn't a generic "couldn't read") rather than a silent empty.
  if (lastError) {
    throw new Error(lastError instanceof Error ? lastError.message : String(lastError));
  }
  return [];
}

// Fetch recent entries for a bilibili source. Returns newest-first.
export async function fetchBilibiliEntries(env: Env, src: BiliSource): Promise<FeedEntry[]> {
  if (src.kind === "season" || src.kind === "series") {
    return fetchBilibiliListEntries(env, src);
  }

  const cookie = await getBilibiliCookie(env);
  // space: the UP主's dynamic feed, filtered to video posts.
  const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=&host_mid=${src.mid}&timezone_offset=-480&features=itemOpusStyle`;
  const response = await biliGet<BiliDynamicResponse>(url, `https://space.bilibili.com/${src.mid}/dynamic`, cookie);
  return (response.data?.items ?? []).flatMap((item) => {
    const archive = item.modules?.module_dynamic?.major?.archive;
    if (!archive?.bvid) return [];

    return [
      videoEntry(
        String(archive.bvid),
        String(archive.title ?? ""),
        Number(item.modules?.module_author?.pub_ts) || null,
        archive.duration_text,
      ),
    ];
  });
}
