// Minimal RSS / Atom parser for Workers (no DOM). Handles the common shapes:
// RSS <item> (link/guid/pubDate/enclosure) and Atom <entry> (link href/id/published).
export interface FeedEntry {
  title: string | null;
  link: string | null;
  guid: string | null;
  published: string | null; // ISO string when parseable
  audio: string | null;
}

export interface ParsedFeed {
  title: string | null;
  entries: FeedEntry[];
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!m) return null;
  return decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
}

function attr(block: string, name: string, attrName: string): string | null {
  const m = new RegExp(`<${name}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "i").exec(block);
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

export function parseFeed(xml: string): ParsedFeed {
  const feedTitle = tag(xml, "title");
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
