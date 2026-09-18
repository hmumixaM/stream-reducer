import type { Env } from "../env";
import { all } from "../db";
import { isoNow } from "./crypto";

export const BULLETIN_LANGUAGES = new Set(["zh"]);

export function parseBulletin(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((point) => {
        if (typeof point === "string") return point.trim();
        if (point && typeof point === "object" && "text" in point) return String(point.text ?? "").trim();
        return "";
      })
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    return [];
  }
}

/** Queue missing localized bulletins without touching the detailed summary. */
export async function enqueueBulletinTranslations(
  env: Env,
  itemIds: number[],
  lang: string,
): Promise<number> {
  if (!BULLETIN_LANGUAGES.has(lang)) return 0;
  const ids = [...new Set(itemIds.filter((id) => Number.isFinite(id) && id > 0))];
  let enqueued = 0;
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batchIds = ids.slice(offset, offset + 100);
    if (!batchIds.length) continue;
    const placeholders = batchIds.map(() => "?").join(",");
    const existing = await all<{ item_id: number; status: string }>(env.DB.prepare(
      `SELECT item_id, status FROM bulletin_translation
        WHERE lang = ? AND item_id IN (${placeholders})`,
    ).bind(lang, ...batchIds));
    const byId = new Map(existing.map((row) => [row.item_id, row.status]));
    const pending = batchIds.filter((id) => !byId.has(id) || byId.get(id) === "error");
    if (!pending.length) continue;
    await env.DB.batch(pending.map((id) => env.DB.prepare(
      `INSERT INTO bulletin_translation (item_id, lang, bulletin, status, error, updated_at)
       VALUES (?, ?, '[]', 'queued', NULL, ?)
       ON CONFLICT(item_id, lang) DO UPDATE SET status='queued', error=NULL, updated_at=excluded.updated_at
       WHERE bulletin_translation.status = 'error'`,
    ).bind(id, lang, isoNow())));
    try {
      await env.PIPELINE.sendBatch(pending.map((id) => ({
        body: { kind: "bulletin_translate" as const, item_id: id, lang },
      })));
      enqueued += pending.length;
    } catch (error) {
      await env.DB.batch(pending.map((id) => env.DB.prepare(
        `UPDATE bulletin_translation SET status='error', error=?, updated_at=?
           WHERE item_id=? AND lang=? AND status='queued'`,
      ).bind(String(error).slice(0, 2000), isoNow(), id, lang)));
      throw error;
    }
  }
  return enqueued;
}

export async function enqueueBulletinTranslation(env: Env, itemId: number, lang: string): Promise<number> {
  return enqueueBulletinTranslations(env, [itemId], lang);
}

/** Keep newly completed sources in sync for every user who chose Chinese. */
export async function enqueuePreferredBulletinTranslation(env: Env, itemId: number): Promise<number> {
  const user = await env.DB.prepare(
    "SELECT id FROM user WHERE preferred_language = 'zh' LIMIT 1",
  ).first<{ id: number }>();
  return user ? enqueueBulletinTranslation(env, itemId, "zh") : 0;
}
