import type { Env } from "../env";
import { first } from "../db";

// Same threshold the summarizer uses: a source that is already predominantly
// Chinese stays in Chinese, and is not regenerated as a Chinese edition.
export function isPredominantlyChinese(text: string): boolean {
  const sample = (text || "").slice(0, 8000);
  let cjk = 0;
  let latin = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) latin += 1;
  }
  return cjk >= 20 && cjk >= latin;
}

export async function sourceAlreadyChinese(env: Env, itemId: number): Promise<boolean> {
  const row = await first<{ sample: string | null }>(
    env.DB.prepare(
      `SELECT substr(COALESCE(s.markdown, t.text, ''), 1, 8000) AS sample
         FROM item i
         LEFT JOIN summary s ON s.item_id = i.id
         LEFT JOIN transcript t ON t.item_id = i.id
        WHERE i.id = ?`,
    ).bind(itemId),
  );
  return isPredominantlyChinese(row?.sample || "");
}
