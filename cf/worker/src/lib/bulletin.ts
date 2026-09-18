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
  for (let offset = 0; offset < ids.length; offset += 99) {
    const batchIds = ids.slice(offset, offset + 99);
    if (!batchIds.length) continue;
    const placeholders = batchIds.map(() => "?").join(",");
    const existing = await all<{ item_id: number; status: string; headline: string; tldr: string }>(env.DB.prepare(
      `SELECT item_id, status, headline, tldr FROM bulletin_translation
        WHERE lang = ? AND item_id IN (${placeholders})`,
    ).bind(lang, ...batchIds));
    const byId = new Map(existing.map((row) => [row.item_id, row]));
    const pending = batchIds.filter((id) => !byId.has(id) || byId.get(id)?.status === "error" || (byId.get(id)?.status === "done" && (!byId.get(id)?.headline || !byId.get(id)?.tldr)));
    if (!pending.length) continue;
    await env.DB.batch(pending.map((id) => env.DB.prepare(
      `INSERT INTO bulletin_translation (item_id, lang, bulletin, status, error, updated_at)
       VALUES (?, ?, '[]', 'queued', NULL, ?)
       ON CONFLICT(item_id, lang) DO UPDATE SET status='queued', error=NULL, attempts=0, next_attempt_at=NULL, updated_at=excluded.updated_at
       WHERE bulletin_translation.status = 'error' OR (bulletin_translation.status='done' AND (bulletin_translation.headline='' OR bulletin_translation.tldr=''))`,
    ).bind(id, lang, isoNow())));
    enqueued += pending.length;
  }
  // Queue messages are wake-ups, not the ordering authority. Persist all work
  // first; consumers select the newest eligible source from D1 on every claim.
  // A failed send leaves durable queued rows for the cron safety pump.
  if (ids.length) await wakeBulletinWorkers(env, Math.min(enqueued || 1, 6));
  return enqueued;
}

export async function wakeBulletinWorkers(env: Env, count = 6) {
  await env.BULLETIN_JOBS.sendBatch(Array.from({ length: count }, () => ({
    body: { kind: "bulletin_drain" as const },
  })));
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
