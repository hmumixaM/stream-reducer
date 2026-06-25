// Platform detection + URL canonicalization, ported from app/adapters/registry.py.
// Keeping these identical to the Python implementation guarantees the same
// dedup key for a given source URL across the Worker and the pipeline container.

import { isBilibiliListUrl } from "./bilibili";

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

// Guard for manual library adds: a single video/episode is allowed, but a
// channel / user space / playlist / feed page is not (those belong in a
// subscription, which expands them at poll time). Adding a channel as an item
// makes yt-dlp treat it as a giant playlist and hang. Returns a user-facing
// error string for non-item URLs, or null when the URL is an acceptable item.
// Only the video platforms (YouTube, Bilibili) are restricted; podcast/RSS/
// 小宇宙 links are single episodes and pass through.
export function nonItemUrlError(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null; // not a URL: let downstream handling deal with it
  }
  const host = (parsed.hostname || "").toLowerCase();
  const path = parsed.pathname;
  const platform = detectPlatform(rawUrl);

  if (platform === "bilibili") {
    if (host.endsWith("space.bilibili.com")) {
      // 合集/系列 lists are expandable playlists: the add path expands them into
      // their videos, so allow them here. A bare UP主 space (channel) is not a
      // single item and belongs in a subscription.
      if (isBilibiliListUrl(rawUrl)) return null;
      return "This is a Bilibili channel page, not a video — add it as a subscription, or open a specific 合集/系列 list.";
    }
    if (BV_RE.test(path) || /\/av\d+/i.test(path) || host === "b23.tv") return null;
    return "This Bilibili link isn't a single video — paste a /video/BV… URL, or add the channel as a subscription.";
  }

  if (platform === "youtube") {
    if (path.startsWith("/feeds/")) return "This is a YouTube feed, not a video.";
    if (/^\/(channel\/|c\/|user\/|@|playlist)/.test(path) || path === "/") {
      return "This is a YouTube channel/playlist, not a video — add it as a subscription instead.";
    }
    if (host.endsWith("youtu.be")) {
      return path.replace(/^\/+/, "") ? null : "Missing YouTube video id.";
    }
    if (path.includes("/shorts/") || path.includes("/embed/")) return null;
    if (path.includes("/watch")) {
      return parsed.searchParams.get("v") ? null : "Missing YouTube video id.";
    }
    return "This YouTube link isn't a single video.";
  }

  return null;
}

// Split a free-text blob of URLs (whitespace/comma separated) into a clean list.
export function splitUrls(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}
