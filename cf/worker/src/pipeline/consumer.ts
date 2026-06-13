import type { Env, PipelineMessage } from "../env";
import { first, type ItemRow } from "../db";
import { isoNow } from "../lib/crypto";
import { recomputePriority } from "../lib/ingest";
import { runPipeline, fetchMetadata, type PipelineResult } from "./container";
import { pollSubscription } from "./subscriptions";
import { buildGraph } from "./graph_build";

export async function handleMessage(env: Env, msg: PipelineMessage): Promise<void> {
  switch (msg.kind) {
    case "process":
      return processItem(env, msg.item_id);
    case "resummarize":
      return processItem(env, msg.item_id, true);
    case "poll":
      await pollSubscription(env, msg.subscription_id);
      return;
    case "graph_build":
      await buildGraph(env, msg.force ?? false);
      return;
  }
}

async function processItem(env: Env, itemId: number, resummarize = false): Promise<void> {
  const item = await first<ItemRow>(env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(itemId));
  if (!item) return;

  await env.DB.prepare("UPDATE item SET status = 'fetching', started_at = ?, error = NULL WHERE id = ?")
    .bind(isoNow(), itemId)
    .run();

  try {
    // Metadata-first: fetch + persist lightweight metadata before the expensive
    // transcribe/summarize stages, so prioritization signals are populated early.
    if (!resummarize) {
      const meta = await fetchMetadata(env, item.source_url, item.platform).catch(() => null);
      if (meta) {
        await persistMetadata(env, itemId, meta);
        await recomputePriority(env, itemId);
      }
    }

    let transcript = null;
    if (resummarize) {
      const t = await first<{ language: string | null; source: string; segments: string; text: string }>(
        env.DB.prepare("SELECT language, source, segments, text FROM transcript WHERE item_id = ?").bind(itemId),
      );
      if (t) transcript = { language: t.language, source: t.source, segments: JSON.parse(t.segments || "[]"), text: t.text };
    }

    const result = await runPipeline(env, {
      item_id: itemId,
      source_url: item.source_url,
      platform: item.platform,
      mode: resummarize ? "resummarize" : "process",
      transcript,
    });
    if (result.error) throw new Error(result.error);

    await persistResult(env, itemId, result);
    await embedChunks(env, itemId);

    await env.DB.prepare("UPDATE item SET status = 'done', completed_at = ?, error = NULL WHERE id = ?")
      .bind(isoNow(), itemId)
      .run();
    // Flip every user's saved copy of this content to done (dedup payoff).
    await env.DB.prepare("UPDATE user_item SET personal_status = 'done' WHERE item_id = ?").bind(itemId).run();
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await env.DB.prepare(
      "UPDATE item SET status = 'error', error = ?, retry_count = retry_count + 1 WHERE id = ?",
    )
      .bind(msg.slice(0, 4000), itemId)
      .run();
    throw err; // let the Queue retry per max_retries
  }
}

async function persistMetadata(env: Env, itemId: number, m: PipelineResult["metadata"]): Promise<void> {
  await env.DB.prepare(
    `UPDATE item SET
       title = COALESCE(?, title), author = COALESCE(?, author),
       description = COALESCE(?, description), duration_s = COALESCE(?, duration_s),
       published_at = COALESCE(?, published_at), thumbnail = COALESCE(?, thumbnail),
       external_id = COALESCE(?, external_id), view_count = COALESCE(?, view_count),
       like_count = COALESCE(?, like_count), dislike_count = COALESCE(?, dislike_count)
     WHERE id = ?`,
  )
    .bind(
      m.title ?? null, m.author ?? null, m.description ?? null, m.duration_s ?? null,
      m.published_at ?? null, m.thumbnail ?? null, m.external_id ?? null,
      m.view_count ?? null, m.like_count ?? null, m.dislike_count ?? null, itemId,
    )
    .run();
}

async function persistResult(env: Env, itemId: number, r: PipelineResult): Promise<void> {
  await persistMetadata(env, itemId, r.metadata);

  // Media -> R2 (optional; container only returns audio when under the limit).
  let mediaKey: string | null = null;
  if (r.media.audio_b64) {
    mediaKey = `audio/${itemId}.${r.media.format || "mp3"}`;
    const bytes = Uint8Array.from(atob(r.media.audio_b64), (ch) => ch.charCodeAt(0));
    await env.MEDIA.put(mediaKey, bytes);
  }
  await env.DB.prepare("UPDATE item SET media_key = ?, media_bytes = ?, audio_duration_s = ? WHERE id = ?")
    .bind(mediaKey, r.media.bytes, r.media.duration_s ?? null, itemId)
    .run();

  if (r.transcript) {
    await env.DB.prepare(
      `INSERT INTO transcript (item_id, language, source, segments, text)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET language=excluded.language, source=excluded.source,
         segments=excluded.segments, text=excluded.text`,
    )
      .bind(itemId, r.transcript.language, r.transcript.source, JSON.stringify(r.transcript.segments), r.transcript.text)
      .run();
  }
  if (r.summary) {
    await env.DB.prepare(
      `INSERT INTO summary (item_id, model, prompt_version, markdown, structured)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET model=excluded.model, prompt_version=excluded.prompt_version,
         markdown=excluded.markdown, structured=excluded.structured`,
    )
      .bind(itemId, r.summary.model, r.summary.prompt_version, r.summary.markdown, JSON.stringify(r.summary.structured))
      .run();
  }

  // Replace chunk rows (embeddings filled in by embedChunks).
  await env.DB.prepare("DELETE FROM chunk WHERE item_id = ?").bind(itemId).run();
  for (const ch of r.chunks) {
    await env.DB.prepare(
      `INSERT INTO chunk (item_id, source, field, chunk_index, text, start_s, end_s, char_start, char_end, content_hash, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(itemId, ch.source, ch.field, ch.chunk_index, ch.text, ch.start_s, ch.end_s, ch.char_start, ch.char_end, ch.content_hash, Math.max(1, Math.floor(ch.text.length / 4)))
      .run();
  }

  // Stage metrics for the Stats / Queue views.
  let totalMs = 0, totalReq = 0, totalTok = 0, totalCost = 0;
  for (const s of r.stages) {
    await env.DB.prepare(
      `INSERT INTO stage_run (item_id, stage, status, finished_at, duration_ms, attempts, provider, model, request_count, total_tokens, cost_usd, error)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(itemId, s.stage, s.error ? "error" : "done", isoNow(), s.duration_ms, s.provider, s.model, s.request_count, s.total_tokens, s.cost_usd, s.error ?? null)
      .run();
    totalMs += s.duration_ms;
    totalReq += s.request_count;
    totalTok += s.total_tokens;
    totalCost += s.cost_usd;
  }
  await env.DB.prepare(
    "UPDATE item SET total_processing_ms = ?, total_api_requests = ?, total_tokens = ?, total_cost_usd = ? WHERE id = ?",
  )
    .bind(totalMs, totalReq, totalTok, totalCost, itemId)
    .run();
}

// Embed each chunk with Workers AI and upsert into Vectorize + store the vector
// back into the chunk row (so the nightly graph build can read vectors locally).
async function embedChunks(env: Env, itemId: number): Promise<void> {
  const chunks = await env.DB.prepare("SELECT id, source, field, text FROM chunk WHERE item_id = ? ORDER BY id").bind(itemId).all<{ id: number; source: string; field: string; text: string }>();
  const rows = chunks.results ?? [];
  if (!rows.length) return;

  const { embedTexts, EMBEDDING_MODEL } = await import("../lib/embed");
  const vectors = await embedTexts(env, rows.map((r) => r.text));

  const toUpsert = rows.map((r, i) => ({
    id: String(r.id),
    values: vectors[i],
    metadata: { item_id: itemId, source: r.source, field: r.field },
  }));
  await env.VECTORIZE.upsert(toUpsert);

  for (let i = 0; i < rows.length; i++) {
    await env.DB.prepare("UPDATE chunk SET embedding = ?, embedding_model = ? WHERE id = ?")
      .bind(JSON.stringify(vectors[i]), EMBEDDING_MODEL, rows[i].id)
      .run();
  }
}
