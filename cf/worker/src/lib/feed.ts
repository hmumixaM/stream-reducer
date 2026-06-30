import type { Env } from "../env";
import { parseBilibiliUrl, fetchBilibiliEntries } from "./bilibili";

// Minimal RSS / Atom parser for Workers (no DOM). Handles the common shapes:
// RSS <item> (link/guid/pubDate/enclosure) and Atom <entry> (link href/id/published).
export interface FeedEntry {
  title: string | null;
  link: string | null;
  guid: string | null;
  published: string | null; // ISO string when parseable
  audio: string | null;
  duration_s?: number | null; // when the feed exposes it (podcasts, Bilibili)
  description?: string | null;
  thumbnail?: string | null;
  author?: string | null;
}

// Parse a duration that may be a number of seconds or "HH:MM:SS" / "MM:SS".
export function parseDuration(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw > 0 ? Math.round(raw) : null;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{1,2}(:\d{2}){1,2}$/.test(s)) {
    return s.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
  }
  return null;
}

interface ParsedFeed {
  title: string | null;
  entries: FeedEntry[];
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!m) return null;
  return decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
}

function attr(block: string, name: string, attrName: string): string | null {
  // Allow whitespace around `=` (some feeds write `href = "…"`, e.g. wavpub).
  const m = new RegExp(`<${name}\\b[^>]*\\b${attrName}\\s*=\\s*["']([^"']+)["'][^>]*>`, "i").exec(block);
  return m ? decode(m[1]) : null;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function toIso(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Normalize a user-supplied subscription URL into a pollable feed URL.
// YouTube channel pages (/channel/UC…, /@handle, /c/Name, /user/Name, with or
// without a /videos|/streams|/shorts suffix) are converted to the channel's
// Atom feed (https://www.youtube.com/feeds/videos.xml?channel_id=…). Handles and
// custom URLs don't expose the channel id in the path, so the page is fetched
// once and the id extracted. Non-YouTube and already-feed URLs pass through.
export async function resolveFeedUrl(input: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  const host = url.hostname.toLowerCase();
  // Apple Podcasts show page -> the show's RSS feed.
  if (host.endsWith("podcasts.apple.com") || host.endsWith("itunes.apple.com")) {
    const idMatch = url.pathname.match(/\/id(\d+)/);
    // 1. iTunes Lookup API — clean + canonical, but Apple returns 403 to shared
    //    datacenter egress (incl. Cloudflare Workers), so it often fails here.
    if (idMatch) {
      const feed = await itunesFeedUrl(idMatch[1]);
      if (feed) return feed;
    }
    // 2. Fallback: scrape the show PAGE, which embeds the RSS feed URL as
    //    `"feedUrl":"…"`. The page host (podcasts.apple.com) is served from a
    //    different CDN than the lookup API and is usually reachable when the API
    //    is 403'd.
    const scraped = await applePageFeedUrl(input);
    if (scraped) return scraped;
    return input;
  }

  // Bilibili space / playlist pages are resolved at poll time (no static feed
  // URL); pass the canonical page URL through.
  if (host.endsWith("space.bilibili.com")) return input;

  if (host.includes("youtube.com") || host.includes("youtube-nocookie.com")) {
    if (url.pathname.startsWith("/feeds/videos.xml")) return input;

    const byChannel = url.pathname.match(/^\/channel\/(UC[0-9A-Za-z_-]{22})/);
    if (byChannel) return youtubeFeed(byChannel[1]);

    if (/^\/(@[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/.test(url.pathname)) {
      const channelId = await fetchYoutubeChannelId(input);
      if (channelId) return youtubeFeed(channelId);
    }
  }
  return input;
}

// Resolve an Apple Podcasts show id to its RSS feed via the iTunes Lookup API.
// Apple aggressively rate-limits/blocks shared datacenter egress (a bare,
// UA-less request from the Worker often gets a 403/empty body), so this sends a
// browser-ish UA, checks the status, retries with backoff, and — crucially —
// LOGS failures. Previously this swallowed every error and returned null, which
// silently stored the raw podcasts.apple.com URL as the feed (unpollable) with
// no trace of why.
async function itunesFeedUrl(id: string): Promise<string | null> {
  const url = `https://itunes.apple.com/lookup?id=${id}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          accept: "application/json,text/javascript,*/*",
        },
      });
      if (!res.ok) {
        console.warn(`itunesFeedUrl id=${id} http ${res.status} (attempt ${attempt}/3)`);
      } else {
        // iTunes serves this as text/javascript; parse the body as text->JSON so
        // the content-type doesn't matter.
        const data = JSON.parse(await res.text()) as { results?: { feedUrl?: string }[] };
        const feed = data.results?.[0]?.feedUrl ?? null;
        if (feed) return feed;
        console.warn(`itunesFeedUrl id=${id} returned no feedUrl (attempt ${attempt}/3)`);
      }
    } catch (err) {
      console.warn(`itunesFeedUrl id=${id} failed (attempt ${attempt}/3): ${String(err)}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 400));
  }
  console.error(`itunesFeedUrl id=${id} could not resolve a feed after 3 attempts`);
  return null;
}

// Fallback resolver: fetch the Apple Podcasts show page and extract the RSS feed
// URL embedded in its serialized data (`"feedUrl":"https://…"`). Used when the
// iTunes Lookup API is blocked (403) for the Worker's egress.
async function applePageFeedUrl(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) {
      console.warn(`applePageFeedUrl ${pageUrl} http ${res.status}`);
      return null;
    }
    const html = await res.text();
    const m = html.match(/"feedUrl"\s*:\s*"(https:(?:\\\/|\/)[^"]+?)"/);
    if (!m) {
      console.warn(`applePageFeedUrl ${pageUrl} no feedUrl found in page (${html.length} bytes)`);
      return null;
    }
    return m[1].replace(/\\\//g, "/");
  } catch (err) {
    console.warn(`applePageFeedUrl ${pageUrl} failed: ${String(err)}`);
    return null;
  }
}

// Fetch + parse a subscription feed. RSS/Atom (YouTube, Apple, generic) is
// fetched and parsed; Bilibili sources are built from its JSON APIs.
// A YouTube channel Atom feed only ever exposes the latest ~15 uploads, so a
// subscription can never backfill a channel's catalogue from it. Detect the
// channel id and enumerate the full recent uploads via the container's yt-dlp
// instead (which also yields each video's duration + approximate date, so the
// poll's duration floor + publish-date window still apply).
const YT_CHANNEL_FEED_RE = /youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[0-9A-Za-z_-]+)/i;

export async function fetchFeed(env: Env, feedUrl: string): Promise<ParsedFeed> {
  const bili = parseBilibiliUrl(feedUrl);
  if (bili) {
    const entries = await fetchBilibiliEntries(env, bili);
    return { title: null, entries };
  }

  const ytChannel = feedUrl.match(YT_CHANNEL_FEED_RE);
  if (ytChannel) {
    const channelUrl = `https://www.youtube.com/channel/${ytChannel[1]}/videos`;
    const { fetchFeedEntries } = await import("../pipeline/container");
    const raw = await fetchFeedEntries(env, channelUrl);
    const entries: FeedEntry[] = raw
      .filter((e) => e.external_id)
      .map((e) => ({
        title: e.title,
        link: `https://www.youtube.com/watch?v=${e.external_id}`,
        // Match the Atom feed's guid shape so last_seen_guid stays continuous.
        guid: `yt:video:${e.external_id}`,
        published: e.published,
        audio: null,
        duration_s: e.duration_s,
      }));
    return { title: null, entries };
  }

  const res = await fetch(feedUrl, { headers: { "user-agent": "stream-reduce/1.0" } });
  return parseFeed(await res.text());
}

function youtubeFeed(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

// Fetch a YouTube channel/handle page and pull the canonical channel id out of
// the embedded JSON (works for @handles, /c/ and /user/ custom URLs).
async function fetchYoutubeChannelId(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    const html = await res.text();
    const m =
      html.match(/"(?:channelId|externalId)":"(UC[0-9A-Za-z_-]{22})"/) ||
      html.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// The channel/show-level cover: <itunes:image href> or RSS <image><url>. Many
// podcasts (e.g. 毕业进化录) ship NO per-episode image, so episodes fall back to
// this so they aren't cover-less.
function feedLevelImage(xml: string): string | null {
  // Strip <item> blocks first so we read the CHANNEL image, not the first item's.
  const channel = xml.replace(/<item\b[\s\S]*?<\/item>/gi, "");
  const itunes = attr(channel, "itunes:image", "href");
  if (itunes) return itunes;
  const m = /<image\b[^>]*>[\s\S]*?<url>([\s\S]*?)<\/url>/i.exec(channel);
  return m ? decode(m[1].trim()) : null;
}

export function parseFeed(xml: string): ParsedFeed {
  const feedTitle = tag(xml, "title");
  const feedImage = feedLevelImage(xml);
  const entries: FeedEntry[] = [];

  // RSS items
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    let audio: string | null = null;
    const enc = /<enclosure\b[^>]*>/i.exec(block);
    if (enc) {
      const href = /url=["']([^"']+)["']/i.exec(enc[0]);
      if (href) audio = decode(href[1]);
    }
    entries.push({
      title: tag(block, "title"),
      link: tag(block, "link"),
      guid: tag(block, "guid") || tag(block, "link"),
      published: toIso(tag(block, "pubDate") || tag(block, "dc:date")),
      audio,
      duration_s: parseDuration(tag(block, "itunes:duration")),
      description: tag(block, "itunes:summary") || tag(block, "description") || tag(block, "content:encoded"),
      thumbnail: attr(block, "itunes:image", "href") || feedImage,
      author: tag(block, "itunes:author") || tag(block, "dc:creator"),
    });
  }

  // Atom entries (e.g. YouTube channel feeds)
  for (const m of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const link = attr(block, "link", "href");
    entries.push({
      title: tag(block, "title"),
      link,
      guid: tag(block, "id") || link,
      published: toIso(tag(block, "published") || tag(block, "updated")),
      audio: null,
    });
  }

  return { title: feedTitle, entries };
}
