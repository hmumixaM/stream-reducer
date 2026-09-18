import type { Env } from "../env";
import { first } from "../db";
import { translateBulletinEdition } from "./bulletinTranslation";

/** Independent consumers always claim newest published sources, regardless of
 * queue delivery order. The translation lease prevents duplicate model calls. */
export async function processNextBulletin(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 120_000).toISOString();
  await env.DB.prepare(`UPDATE bulletin_translation SET status='error',error='Translation timed out after 3 attempts'
    WHERE lang='zh' AND status='processing' AND updated_at<? AND attempts>=3`).bind(stale).run();
  for (let collision = 0; collision < 8; collision++) {
    const next = await first<{ item_id: number }>(env.DB.prepare(`
      SELECT bt.item_id FROM bulletin_translation bt
      JOIN item i ON i.id=bt.item_id JOIN summary s ON s.item_id=i.id
      WHERE bt.lang='zh' AND i.status='done' AND (
        bt.status='queued'
        OR (bt.status='error' AND bt.attempts<3 AND (bt.next_attempt_at IS NULL OR bt.next_attempt_at<=?))
        OR (bt.status='processing' AND bt.attempts<3 AND bt.updated_at<?))
      ORDER BY COALESCE(julianday(i.published_at),julianday(i.created_at),0) DESC, i.id DESC LIMIT 1
    `).bind(now, stale));
    if (!next) {
      const waiting = await first<{ item_id: number }>(env.DB.prepare(`
        SELECT bt.item_id FROM bulletin_translation bt JOIN item i ON i.id=bt.item_id
        JOIN summary s ON s.item_id=i.id WHERE bt.lang='zh' AND i.status='done'
        AND (bt.status='processing' OR (bt.status='error' AND bt.attempts<3)) LIMIT 1
      `));
      // Recover evicted requests and delayed retries without waiting for cron.
      if (waiting) await env.BULLETIN_JOBS.send({ kind: "bulletin_drain" }, { delaySeconds: 60 });
      return;
    }
    try {
      let claimed = false;
      await translateBulletinEdition(env, next.item_id, "zh", () => { claimed = true; });
      if (!claimed) continue; // Another worker claimed or completed this source.
    } catch (error) {
      // The translator persists bounded attempts/backoff; a bad source must
      // not block the next item or create an immediate infinite retry loop.
      console.error("bulletin translation failed", next.item_id, String(error));
    }
    await env.BULLETIN_JOBS.send({ kind: "bulletin_drain" });
    return;
  }
  await env.BULLETIN_JOBS.send({ kind: "bulletin_drain" }, { delaySeconds: 1 });
}
