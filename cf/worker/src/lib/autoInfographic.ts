import type { Env } from "../env";
import { all, first } from "../db";
import { isoNow } from "./crypto";

export async function isInfographicContentReady(
  env: Env,
  itemId: number,
): Promise<boolean> {
  const item = await first<{ id: number }>(
    env.DB.prepare(
      `SELECT i.id
         FROM item i
         JOIN summary s ON s.item_id = i.id
        WHERE i.id = ? AND i.status = 'done'`,
    ).bind(itemId),
  );
  if (!item) return false;

  const collections = await all<{ auto_translate_langs: string }>(
    env.DB.prepare(
      `SELECT c.auto_translate_langs
         FROM collection_item ci
         JOIN collection c ON c.id = ci.collection_id
        WHERE ci.item_id = ? AND c.auto_infographic = 1`,
    ).bind(itemId),
  );
  const requiredLanguages = new Set<string>();
  for (const collection of collections) {
    for (const language of JSON.parse(collection.auto_translate_langs) as string[]) {
      requiredLanguages.add(language);
    }
  }
  if (requiredLanguages.size) {
    const translations = await all<{ lang: string; status: string }>(
      env.DB.prepare(
        "SELECT lang, status FROM item_translation WHERE item_id = ?",
      ).bind(itemId),
    );
    const completed = new Set(
      translations
        .filter((translation) => translation.status === "done")
        .map((translation) => translation.lang),
    );
    if ([...requiredLanguages].some((language) => !completed.has(language))) {
      return false;
    }
  }
  return true;
}

export async function enqueueAutomaticInfographic(
  env: Env,
  itemId: number,
): Promise<boolean> {
  const automaticCollection = await first<{ id: number }>(
    env.DB.prepare(
      `SELECT c.id
         FROM collection_item ci
         JOIN collection c ON c.id = ci.collection_id
        WHERE ci.item_id = ? AND c.auto_infographic = 1
        LIMIT 1`,
    ).bind(itemId),
  );
  if (!automaticCollection) return false;
  if (!await isInfographicContentReady(env, itemId)) return false;

  const result = await env.DB.prepare(
    `INSERT INTO item_infographic (item_id, status)
     VALUES (?, 'queued')
     ON CONFLICT(item_id) DO UPDATE SET
       status = 'queued',
       error = NULL,
       updated_at = excluded.updated_at
     WHERE item_infographic.status = 'error'`,
  ).bind(itemId).run();
  if ((result.meta.changes ?? 0) === 0) return false;

  try {
    await env.PIPELINE.send({ kind: "infographic", item_id: itemId });
  } catch (error) {
    await env.DB.prepare(
      `UPDATE item_infographic
          SET status = 'error', error = ?, updated_at = ?
        WHERE item_id = ? AND status = 'queued'`,
    ).bind(String(error), isoNow(), itemId).run();
    throw error;
  }
  return true;
}
