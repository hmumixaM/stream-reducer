// Bilibili subscription sources. Bilibili has no native RSS, so we build feed
// entries from its web JSON APIs. Three kinds are supported:
//   - space   : an UP主's recent video uploads (via the web-dynamic feed, which
//               isn't as aggressively risk-controlled as space/arc/search)
//   - season  : a 合集 (collection) playlist
//   - series  : a 系列 playlist
// Enumeration runs through the WARP-backed pipeline container because
// Cloudflare Worker egress is consistently blocked by Bilibili risk control.
import type { Env } from "../env";
import type { FeedEntry } from "./feed";

interface ContainerFeedEntry {
  external_id: string | null;
  title: string | null;
  duration_s: number | null;
  published: string | null;
}

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

function containerFeedEntries(
  raw: ContainerFeedEntry[],
): FeedEntry[] {
  return raw
    .filter((entry) => entry.external_id)
    .map((entry): FeedEntry => ({
      title: entry.title,
      link: `https://www.bilibili.com/video/${entry.external_id}`,
      guid: entry.external_id,
      published: entry.published,
      audio: null,
      duration_s: entry.duration_s,
    }));
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
    const entries = containerFeedEntries(raw);
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

  // The public dynamic API consistently risk-controls Cloudflare Worker egress
  // (HTTP 412/HTML). Enumerate uploader videos through the WARP-backed
  // container, matching the reliable list path and the actual download egress.
  const { fetchFeedEntries } = await import("../pipeline/container");
  return containerFeedEntries(
    await fetchFeedEntries(env, `https://space.bilibili.com/${src.mid}/video`),
  );
}
