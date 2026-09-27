import type { Env } from "../env";
import { all, first } from "../db";
import { isoNow } from "./crypto";
import { isPredominantlyChinese, sourceAlreadyChinese } from "./chinese";

const SUPPORTED_LANGUAGES = new Set([
  "en",
  "zh",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "ru",
]);

export async function enqueueAutomaticTranslations(
  env: Env,
  itemId: number,
): Promise<string[]> {
  const rows = await all<{ auto_translate_langs: string }>(
    env.DB.prepare(
      `SELECT c.auto_translate_langs
         FROM collection_item ci
         JOIN collection c ON c.id = ci.collection_id
        WHERE ci.item_id = ? AND c.is_public = 1`,
    ).bind(itemId),
  );
  const languages = new Set<string>();
  for (const row of rows) {
    for (const language of JSON.parse(row.auto_translate_langs) as string[]) {
      if (SUPPORTED_LANGUAGES.has(language)) languages.add(language);
    }
  }
  return enqueueTranslationLanguages(env, itemId, [...languages]);
}

const QUEUE_TRANSLATION = `INSERT INTO item_translation (item_id, lang, status)
       VALUES (?, ?, 'queued')
       ON CONFLICT(item_id, lang) DO UPDATE SET
         status = 'queued',
         error = NULL,
         updated_at = excluded.updated_at
       WHERE item_translation.status = 'error'`;

export async function enqueueTranslationLanguages(
  env: Env,
  itemId: number,
  languages: string[],
): Promise<string[]> {
  const enqueued: string[] = [];
  for (const language of languages) {
    if (!SUPPORTED_LANGUAGES.has(language)) {
      throw new Error(`unsupported translation language: ${language}`);
    }
    if (language === "zh" && await sourceAlreadyChinese(env, itemId)) continue;
    const result = await env.DB.prepare(QUEUE_TRANSLATION).bind(itemId, language).run();
    if ((result.meta.changes ?? 0) === 0) continue;
    try {
      await env.PIPELINE.send({ kind: "translate", item_id: itemId, lang: language });
    } catch (error) {
      await env.DB.prepare(
        `UPDATE item_translation
            SET status = 'error', error = ?, updated_at = ?
          WHERE item_id = ? AND lang = ? AND status = 'queued'`,
      ).bind(String(error), isoNow(), itemId, language).run();
      throw error;
    }
    enqueued.push(language);
  }
  return enqueued;
}

// Full-summary editions for one library. Finished and in-flight rows are left
// alone; only a missing or previously failed edition is queued.
export async function enqueueLibraryContentTranslations(
  env: Env,
  userId: number,
  lang: string,
): Promise<number> {
  if (!SUPPORTED_LANGUAGES.has(lang)) {
    throw new Error(`unsupported translation language: ${lang}`);
  }
  const rows = await all<{ id: number; sample: string | null }>(
    env.DB.prepare(
      `SELECT i.id, substr(COALESCE(s.markdown, t.text, ''), 1, 8000) AS sample
         FROM user_item ui
         JOIN item i ON i.id = ui.item_id
         JOIN transcript t ON t.item_id = i.id
         LEFT JOIN summary s ON s.item_id = i.id
        WHERE ui.user_id = ? AND i.status = 'done'`,
    ).bind(userId),
  );
  const ids = rows
    .filter((row) => lang !== "zh" || !isPredominantlyChinese(row.sample || ""))
    .map((row) => row.id);
  return enqueueContentTranslations(env, ids, lang);
}

// When a source finishes, give it the full edition preferred by someone who
// already has it in their library.
export async function enqueuePreferredContentTranslation(env: Env, itemId: number): Promise<number> {
  const row = await first<{ ok: number }>(
    env.DB.prepare(
      `SELECT 1 AS ok
         FROM user_item ui
         JOIN user u ON u.id = ui.user_id
        WHERE ui.item_id = ? AND u.preferred_language = 'zh'
        LIMIT 1`,
    ).bind(itemId),
  );
  if (!row) return 0;
  const queued = await enqueueTranslationLanguages(env, itemId, ["zh"]);
  return queued.length;
}

async function enqueueContentTranslations(env: Env, itemIds: number[], lang: string): Promise<number> {
  const unique = [...new Set(itemIds)];
  let enqueued = 0;
  for (let offset = 0; offset < unique.length; offset += 80) {
    const batch = unique.slice(offset, offset + 80);
    const results = await env.DB.batch(
      batch.map((id) => env.DB.prepare(QUEUE_TRANSLATION).bind(id, lang)),
    );
    const pending = batch.filter((_, index) => (results[index]?.meta.changes ?? 0) > 0);
    if (!pending.length) continue;
    try {
      await env.PIPELINE.sendBatch(
        pending.map((id) => ({ body: { kind: "translate" as const, item_id: id, lang } })),
      );
    } catch (error) {
      await env.DB.batch(pending.map((id) => env.DB.prepare(
        `UPDATE item_translation SET status = 'error', error = ?, updated_at = ?
          WHERE item_id = ? AND lang = ? AND status = 'queued'`,
      ).bind(String(error), isoNow(), id, lang)));
      throw error;
    }
    enqueued += pending.length;
  }
  return enqueued;
}
