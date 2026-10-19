import type { Env } from "../env";
import {
  readCached,
  sourceHash,
  type ReadingRow,
  type ReadingSummary,
} from "./readingSummary";
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const section = (title: string, text: string, lang?: string) =>
  text.trim()
    ? `<section${lang ? ` lang="${esc(lang)}"` : ""}><h2>${esc(title)}</h2><div class="whitespace-pre-wrap my-4">${esc(text)}</div></section>`
    : "";
const clock = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
export function readingText(r: ReadingSummary | null) {
  return r
    ? [
        r.lead,
        ...r.sections.map(
          (s) =>
            `${s.heading}${s.timestamp === null ? "" : ` (${clock(s.timestamp)})`}\n${s.body}`,
        ),
        r.conclusion,
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
}
export async function mediaContent(
  env: Env,
  item: {
    id: number;
    title: string;
    author: string | null;
    source_url: string;
    structured: string;
    markdown: string;
  },
) {
  const [reading, chinese, translations, transcript, bulletin] =
    await Promise.all([
      env.DB.prepare("SELECT * FROM reading_summary WHERE item_id=?")
        .bind(item.id)
        .first<ReadingRow>(),
      env.DB.prepare(
        "SELECT * FROM reading_summary_lang WHERE item_id=? AND lang='zh'",
      )
        .bind(item.id)
        .first<ReadingRow>(),
      env.DB.prepare(
        "SELECT lang,markdown,structured FROM item_translation WHERE item_id=? AND status='done' AND length(trim(markdown))>0 ORDER BY lang",
      )
        .bind(item.id)
        .all<{ lang: string; markdown: string; structured: string }>(),
      env.DB.prepare(
        "SELECT language,text,segments FROM transcript WHERE item_id=?",
      )
        .bind(item.id)
        .first<{ language: string; text: string; segments: string }>(),
      env.DB.prepare(
        "SELECT headline,subhead,tldr,bulletin FROM bulletin_translation WHERE item_id=? AND lang='zh' AND status='done'",
      )
        .bind(item.id)
        .first<{
          headline: string;
          subhead: string;
          tldr: string;
          bulletin: string;
        }>(),
    ]);
  const hash = await sourceHash({
    ...item,
    summary_markdown: item.markdown,
    summary_structured: item.structured,
  });
  const parts: { title: string; text: string; lang?: string }[] = [];
  if (bulletin?.tldr) {
    let points: string[] = [];
    try {
      const values = JSON.parse(bulletin.bulletin);
      if (Array.isArray(values))
        points = values.flatMap((p) =>
          typeof p === "string"
            ? [p]
            : typeof p?.text === "string"
              ? [
                  `${p.text}${typeof p.timestamp === "number" ? ` (${clock(p.timestamp)})` : ""}`,
                ]
              : [],
        );
    } catch {
      /* Preserve the completed introduction. */
    }
    parts.push({
      title: "中文简报",
      text: [bulletin.headline, bulletin.subhead, bulletin.tldr, ...points]
        .filter(Boolean)
        .join("\n\n"),
      lang: "zh-CN",
    });
  }
  const original = readingText(readCached(reading, hash).content);
  if (original) parts.push({ title: "Reading summary", text: original });
  const zh = readingText(readCached(chinese, hash).content);
  if (zh) parts.push({ title: "精炼阅读摘要", text: zh, lang: "zh-CN" });
  for (const t of translations.results)
    if (typeof t.lang === "string" && t.markdown?.trim()) {
      parts.push({
        title: `Detailed notes — ${t.lang}`,
        text: t.markdown,
        lang: t.lang === "zh" ? "zh-CN" : t.lang,
      });
      parts.push(...sourceQuotes(t.structured, t.lang));
    }
  parts.push(...sourceQuotes(item.structured));
  if (transcript?.text?.trim()) {
    let text = transcript.text;
    try {
      const segments = JSON.parse(transcript.segments);
      if (
        Array.isArray(segments) &&
        segments.length &&
        segments.every((s) => typeof s.text === "string")
      )
        text = segments
          .map(
            (s) =>
              `${typeof s.start === "number" && s.start >= 0 ? `[${clock(s.start)}] ` : ""}${s.text}`,
          )
          .join("\n");
    } catch {
      /* Preserve the complete plain transcript when segments are unavailable. */
    }
    parts.push({
      title: "Original transcript",
      text,
      lang: transcript.language || undefined,
    });
  }
  return {
    html: parts.map((p) => section(p.title, p.text, p.lang)).join(""),
    markdown: parts.map((p) => `## ${p.title}\n\n${p.text}`).join("\n\n"),
  };
}
function sourceQuotes(
  raw: string,
  lang?: string,
): { title: string; text: string; lang?: string }[] {
  try {
    const data = JSON.parse(raw);
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    const text = quotes
      .flatMap((q: unknown) => {
        if (typeof q === "string") return [q];
        if (!q || typeof q !== "object") return [];
        const v = q as Record<string, unknown>;
        const quote =
          typeof v.text === "string"
            ? v.text
            : typeof v.quote === "string"
              ? v.quote
              : "";
        return quote
          ? [
              `${typeof v.timestamp === "number" ? `[${clock(v.timestamp)}] ` : ""}${typeof v.speaker === "string" ? v.speaker + ": " : ""}${quote}`,
            ]
          : [];
      })
      .join("\n\n");
    return text ? [{ title: "Source quotes", text, lang }] : [];
  } catch {
    return [];
  }
}
