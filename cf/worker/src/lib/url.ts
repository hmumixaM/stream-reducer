// Platform detection + URL canonicalization, ported from app/adapters/registry.py.
// Keeping these identical to the Python implementation guarantees the same
// dedup key for a given source URL across the Worker and the pipeline container.

export type Platform =
  | "youtube"
  | "bilibili"
  | "apple_podcast"
  | "xiaoyuzhou"
  | "rss"
  | "unknown";

const TRACKING_PARAMS = new Set([
  "spm_id_from", "vd_source", "from_source", "from_spmid", "from", "spmid",
  "share_source", "share_medium", "share_plat", "share_session_id", "share_tag",
  "share_times", "unique_k", "buvid", "is_story_h5", "p_av_id", "bbid", "ts",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "feature", "ab_channel", "pp", "si", "gclid", "fbclid",
]);

const BV_RE = /BV[0-9A-Za-z]{8,}/;

export function detectPlatform(url: string): Platform {
  let host = "";
  try {
    host = (new URL(url).hostname || "").toLowerCase();
  } catch {
    return "rss";
  }
  if (["youtube.com", "youtu.be", "youtube-nocookie.com"].some((h) => host.includes(h)))
    return "youtube";
  if (host.includes("bilibili.com") || host === "b23.tv") return "bilibili";
  if (host.includes("podcasts.apple.com") || host.includes("podcast.apple.com"))
    return "apple_podcast";
  if (host.includes("xiaoyuzhoufm.com")) return "xiaoyuzhou";
  return "rss";
}

export function normalizeUrl(rawUrl: string): string {
  const url = (rawUrl || "").trim();
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = (parsed.hostname || "").toLowerCase();
  const platform = detectPlatform(url);

  if (platform === "youtube") {
    let vid = "";
    if (host.endsWith("youtu.be")) {
      vid = parsed.pathname.replace(/^\/+/, "").split("/")[0];
    } else if (parsed.pathname.includes("/shorts/")) {
      vid = parsed.pathname.split("/shorts/")[1].split("/")[0];
    } else if (parsed.pathname.includes("/embed/")) {
      vid = parsed.pathname.split("/embed/")[1].split("/")[0];
    } else {
      vid = parsed.searchParams.get("v") || "";
    }
    if (vid) return `https://www.youtube.com/watch?v=${vid}`;
  }

  if (platform === "bilibili") {
    const m = BV_RE.exec(parsed.pathname) || BV_RE.exec(url);
    if (m) return `https://www.bilibili.com/video/${m[0]}`;
  }

  const kept: [string, string][] = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) kept.push([k, v]);
  }
  const qs = new URLSearchParams(kept).toString();
  return `${parsed.origin}${parsed.pathname}${qs ? `?${qs}` : ""}`;
}

// Split a free-text blob of URLs (whitespace/comma separated) into a clean list.
export function splitUrls(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}
