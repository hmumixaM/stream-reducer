import type { Env } from "../env";
import { all } from "../db";
import { isoNow } from "./crypto";

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
    const result = await env.DB.prepare(
      `INSERT INTO item_translation (item_id, lang, status)
       VALUES (?, ?, 'queued')
       ON CONFLICT(item_id, lang) DO UPDATE SET
         status = 'queued',
         error = NULL,
         updated_at = excluded.updated_at
       WHERE item_translation.status = 'error'`,
    ).bind(itemId, language).run();
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
