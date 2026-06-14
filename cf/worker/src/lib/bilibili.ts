// Bilibili subscription sources. Bilibili has no native RSS, so we build feed
// entries from its web JSON APIs. Three kinds are supported:
//   - space   : an UP主's recent video uploads (via the web-dynamic feed, which
//               isn't as aggressively risk-controlled as space/arc/search)
//   - season  : a 合集 (collection) playlist
//   - series  : a 系列 playlist
// The season/space APIs require a logged-in cookie to pass risk control
// (BILIBILI_COOKIE secret); series works without one.
import type { Env } from "../env";
import type { FeedEntry } from "./feed";

export interface BiliSource {
  kind: "space" | "season" | "series";
  mid: string;
  sid?: string; // season_id / series_id
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

  // Modern playlist URL: /<mid>/lists/<sid>?type=season|series
  const lists = url.pathname.match(/\/lists\/(\d+)/);
  if (lists) {
    const type = url.searchParams.get("type");
    return { kind: type === "series" ? "series" : "season", mid, sid: lists[1] };
  }
  // Legacy playlist URLs.
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

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function biliGet(env: Env, url: string, referer: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "user-agent": UA, referer };
  if (env.BILIBILI_COOKIE) headers["cookie"] = env.BILIBILI_COOKIE;
  const res = await fetch(url, { headers });
  return (await res.json()) as Record<string, unknown>;
}

function videoEntry(bvid: string, title: string, tsSeconds: number | null): FeedEntry {
  return {
    title,
    link: `https://www.bilibili.com/video/${bvid}`,
    guid: bvid,
    published: tsSeconds ? new Date(tsSeconds * 1000).toISOString() : null,
    audio: null,
  };
}

// Fetch recent entries for a bilibili source. Returns newest-first.
export async function fetchBilibiliEntries(env: Env, src: BiliSource): Promise<FeedEntry[]> {
  if (src.kind === "season") {
    const url = `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${src.mid}&season_id=${src.sid}&sort_reverse=false&page_num=1&page_size=30`;
    const d = await biliGet(env, url, `https://space.bilibili.com/${src.mid}`);
    const archives = (((d.data as Record<string, unknown>)?.archives as Record<string, unknown>[]) ?? []);
    return archives.map((a) => videoEntry(String(a.bvid), String(a.title ?? ""), Number(a.pubdate) || null));
  }

  if (src.kind === "series") {
    const url = `https://api.bilibili.com/x/series/archives?mid=${src.mid}&series_id=${src.sid}&only_normal=true&sort=desc&pn=1&ps=30`;
    const d = await biliGet(env, url, `https://space.bilibili.com/${src.mid}`);
    const archives = (((d.data as Record<string, unknown>)?.archives as Record<string, unknown>[]) ?? []);
    return archives.map((a) => videoEntry(String(a.bvid), String(a.title ?? ""), Number(a.pubdate) || null));
  }

  // space: the UP主's dynamic feed, filtered to video posts.
  const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=&host_mid=${src.mid}&timezone_offset=-480&features=itemOpusStyle`;
  const d = await biliGet(env, url, `https://space.bilibili.com/${src.mid}/dynamic`);
  const items = (((d.data as Record<string, unknown>)?.items as Record<string, unknown>[]) ?? []);
  const out: FeedEntry[] = [];
  for (const it of items) {
    const modules = (it.modules as Record<string, unknown>) ?? {};
    const dyn = (modules.module_dynamic as Record<string, unknown>) ?? {};
    const major = (dyn.major as Record<string, unknown>) ?? {};
    const archive = major.archive as Record<string, unknown> | undefined;
    if (!archive?.bvid) continue;
    const author = (modules.module_author as Record<string, unknown>) ?? {};
    out.push(videoEntry(String(archive.bvid), String(archive.title ?? ""), Number(author.pub_ts) || null));
  }
  return out;
}
