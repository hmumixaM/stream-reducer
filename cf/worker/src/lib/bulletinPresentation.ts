type Point = { text: string; timestamp: number | null };
export type BulletinRow = {
  id: number; title: string | null; headline: string | null; subhead: string | null;
  author: string | null; source_url: string; platform: string; duration_s: number | null;
  published_at: string | null; created_at: string; sort_date: number; saved: number;
  summary_structured: string | null; summary_markdown?: string | null;
  localized_bulletin: string | null; localized_bulletin_status: string | null;
  localized_headline?: string | null; localized_subhead?: string | null; localized_tldr?: string | null;
  localized_updated_at?: string | null;
};

export function parseObject(value: string | null): Record<string, unknown> {
  try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
export function parsePoints(raw: unknown): Point[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (typeof entry === "string") return { text: entry.trim(), timestamp: null };
    if (!entry || typeof entry !== "object") return { text: "", timestamp: null };
    return { text: text(entry.text), timestamp: typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp) && entry.timestamp >= 0 ? entry.timestamp : null };
  }).filter((point) => point.text);
}

export function serializeBulletin(row: BulletinRow, language: string, detail = false) {
  const structured = parseObject(row.summary_structured);
  let points = parsePoints(structured.bulletin);
  let localized = false;
  if (language === "zh" && row.localized_bulletin) {
    try {
      const translated = parsePoints(JSON.parse(row.localized_bulletin || "[]"));
      if (translated.length) { points = translated; localized = true; }
    } catch { /* Leave the Chinese edition pending if a historical translation is corrupt. */ }
  }
  const localizedIntro = localized && Boolean(row.localized_headline?.trim() && row.localized_tldr?.trim());
  const localizationStatus = row.localized_bulletin_status === "processing" && row.localized_updated_at && Date.parse(row.localized_updated_at) < Date.now() - 120_000 ? "error" : row.localized_bulletin_status;
  const keyPoints = parsePoints(structured.key_points);
  if (language === "zh" && !localized) points = [];
  else if (!points.length) points = keyPoints.slice(0, 4);
  const base = {
    id: row.id, title: language === "zh" ? (localizedIntro ? row.localized_headline! : "中文简报整理中") : row.headline || row.title || row.source_url,
    source_title: row.title || row.headline || row.source_url,
    subhead: language === "zh" ? (localizedIntro ? row.localized_subhead || "" : "") : row.subhead, author: row.author, platform: row.platform,
    source_url: row.source_url, duration_s: row.duration_s, published_at: row.published_at,
    created_at: row.created_at, saved: Boolean(row.saved),
    bulletin: points.slice(0, 5).map((point) => point.text),
    bulletin_points: points.slice(0, 5),
    bulletin_language: localized ? "zh" : "original",
    bulletin_overview: language === "zh" ? (localizedIntro ? row.localized_tldr! : "") : text(structured.tldr),
    bulletin_intro_ready: language !== "zh" || localizedIntro,
    localization_status: language === "zh" ? (localizedIntro ? "done" : localizationStatus === "done" ? "missing" : localizationStatus || "missing") : "original",
    // Used only for historical content without bulletin points; no duplicate lead on cards.
    summary: points.length ? "" : language === "zh" ? (localizedIntro ? row.localized_tldr || "" : "") : text(structured.tldr) || text(structured.background),
  };
  if (!detail) return base;
  return {
    ...base, markdown: row.summary_markdown || "", tldr: text(structured.tldr),
    key_points: keyPoints.map((point) => point.text), key_point_details: keyPoints,
    background: text(structured.background), atmosphere: text(structured.atmosphere),
    walkthrough: text(structured.walkthrough),
    quotes: Array.isArray(structured.quotes) ? structured.quotes.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const q = value as Record<string, unknown>;
      return text(q.text) ? [{ text: text(q.text), speaker: text(q.speaker), timestamp: typeof q.timestamp === "number" && Number.isFinite(q.timestamp) && q.timestamp >= 0 ? q.timestamp : null }] : [];
    }) : [],
    entities: Array.isArray(structured.entities) ? [...new Set(structured.entities.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))] : [],
  };
}

export const bulletinMetadata = `i.id, i.title, i.headline, i.subhead, i.author, i.source_url, i.platform,
  i.duration_s, i.published_at, i.created_at, (ui.id IS NOT NULL) AS saved,
  COALESCE(julianday(i.published_at),julianday(i.created_at),0) AS sort_date,
  bt.bulletin AS localized_bulletin, bt.status AS localized_bulletin_status,
  bt.headline AS localized_headline, bt.subhead AS localized_subhead, bt.tldr AS localized_tldr,
  bt.updated_at AS localized_updated_at`;
export const bulletinSortDate = "COALESCE(julianday(i.published_at),julianday(i.created_at),0)";


const safe = "CASE WHEN json_valid(s.structured) THEN s.structured ELSE '{}' END";
export const shortSummarySql = `json_object('bulletin',json_extract(${safe},'$.bulletin'),
  'key_points',json_extract(${safe},'$.key_points'),
  'tldr',substr(json_extract(${safe},'$.tldr'),1,900))`;
