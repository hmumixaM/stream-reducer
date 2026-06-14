import type { Env, PipelineMessage } from "../env";
import { first, type ItemRow } from "../db";
import { isoNow } from "../lib/crypto";
import { persistItemMetadata, linkItemFeed, youtubeChannelFeed } from "../lib/ingest";
import { runPipeline, type PipelineResult } from "./container";
import { pollSubscription } from "./subscriptions";
import { buildGraph } from "./graph_build";

export async function handleMessage(env: Env, msg: PipelineMessage): Promise<void> {
  switch (msg.kind) {
    case "process":
      return processNextQueuedItem(env);
    case "resummarize":
      return processItem(env, msg.item_id, true);
    case "translate":
      return translateItem(env, msg.item_id, msg.lang);
    case "poll":
      await pollSubscription(env, msg.subscription_id);
      return;
    case "graph_build":
      await buildGraph(env, msg.force ?? false);
      return;
  }
}

// An item still 'fetching'/'transcribing'/'summarizing' after this long was
// orphaned by a Worker restart/eviction (a queue invocation caps at ~15 min),
// so it's safe to reclaim. Errors are NOT auto-reclaimed (need explicit retry).
const STALE_IN_PROGRESS_MS = 20 * 60 * 1000;
const IN_PROGRESS = ["fetching", "transcribing", "summarizing"];

function staleCutoff(): string {
  return new Date(Date.now() - STALE_IN_PROGRESS_MS).toISOString();
}

async function processNextQueuedItem(env: Env): Promise<void> {
  const item = await claimNextQueuedItem(env);
  if (!item) return;
  await processClaimedItem(env, item, false);
  // Self-drain: keep the (concurrency-1) pipeline moving without relying on one
  // queue message per item. Enqueue the next claimable item, if any.
  await enqueueNextIfWork(env);
}

// Reclaim the next claimable item: a queued one, or one stuck in-progress past
// the stale cutoff (orphaned by a restart). Uses a conditional UPDATE so two
// concurrent claims can't grab the same item.
async function claimNextQueuedItem(env: Env): Promise<ItemRow | null> {
  const cutoff = staleCutoff();
  const placeholders = IN_PROGRESS.map(() => "?").join(",");
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await first<ItemRow>(
      env.DB.prepare(
        `SELECT * FROM item
          WHERE status = 'queued'
             OR (status IN (${placeholders}) AND started_at < ?)
          ORDER BY priority_score DESC, request_count DESC, enqueued_at ASC
          LIMIT 1`,
      ).bind(...IN_PROGRESS, cutoff),
    );
    if (!candidate) return null;

    const res = await env.DB.prepare(
      `UPDATE item SET status = 'fetching', started_at = ?, error = NULL
        WHERE id = ? AND (status = 'queued' OR (status IN (${placeholders}) AND started_at < ?))`,
    )
      .bind(isoNow(), candidate.id, ...IN_PROGRESS, cutoff)
      .run();
    if ((res.meta.changes ?? 0) > 0) {
      return { ...candidate, status: "fetching", error: null, started_at: isoNow() };
    }
  }
  return null;
}

// Enqueue a continuation 'process' message when claimable work remains.
async function enqueueNextIfWork(env: Env): Promise<void> {
  const cutoff = staleCutoff();
  const placeholders = IN_PROGRESS.map(() => "?").join(",");
  const more = await first<{ id: number }>(
    env.DB.prepare(
      `SELECT id FROM item
        WHERE status = 'queued' OR (status IN (${placeholders}) AND started_at < ?)
        LIMIT 1`,
    ).bind(...IN_PROGRESS, cutoff),
  );
  if (more) await env.PIPELINE.send({ kind: "process", item_id: more.id });
}

// Generate a shared, on-demand translation: re-summarize the original
// transcript + metadata with the output language enforced. Result is stored in
// item_translation (keyed by item+lang) and shown to every user.
async function translateItem(env: Env, itemId: number, lang: string): Promise<void> {
  const item = await first<ItemRow>(env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(itemId));
  const t = await first<{ language: string | null; source: string; segments: string; text: string }>(
    env.DB.prepare("SELECT language, source, segments, text FROM transcript WHERE item_id = ?").bind(itemId),
  );
  const fail = async (msg: string) => {
    await env.DB.prepare(
      "UPDATE item_translation SET status = 'error', error = ?, updated_at = ? WHERE item_id = ? AND lang = ?",
    ).bind(msg.slice(0, 2000), isoNow(), itemId, lang).run();
  };
  if (!item || !t) return fail("item has no transcript to translate");

  await env.DB.prepare(
    "UPDATE item_translation SET status = 'processing', error = NULL, updated_at = ? WHERE item_id = ? AND lang = ?",
  ).bind(isoNow(), itemId, lang).run();

  try {
    const result = await runPipeline(env, {
      item_id: itemId,
      source_url: item.source_url,
      platform: item.platform,
      mode: "resummarize",
      target_lang: lang,
      transcript: { language: t.language, source: t.source, segments: JSON.parse(t.segments || "[]"), text: t.text },
      item: {
        title: item.title,
        author: item.author,
        description: item.description,
        duration_s: item.duration_s,
        published_at: item.published_at,
      },
    });
    if (result.error || !result.summary) throw new Error(result.error || "no summary produced");
    await env.DB.prepare(
      `UPDATE item_translation SET status = 'done', model = ?, prompt_version = ?, markdown = ?,
         structured = ?, error = NULL, updated_at = ? WHERE item_id = ? AND lang = ?`,
    )
      .bind(
        result.summary.model,
        result.summary.prompt_version,
        result.summary.markdown,
        JSON.stringify(result.summary.structured),
        isoNow(),
        itemId,
        lang,
      )
      .run();
  } catch (err) {
    await fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    throw err;
  }
}

async function processItem(env: Env, itemId: number, resummarize = false): Promise<void> {
  const item = await first<ItemRow>(env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(itemId));
  if (!item) return;

  await env.DB.prepare("UPDATE item SET status = 'fetching', started_at = ?, error = NULL WHERE id = ?")
    .bind(isoNow(), itemId)
    .run();
  return processClaimedItem(env, { ...item, status: "fetching", error: null }, resummarize);
}

async function processClaimedItem(env: Env, item: ItemRow, resummarize = false): Promise<void> {
  const itemId = item.id;
  try {
    // Metadata is no longer pre-fetched in its own container call (avoids extra
    // container instances / 503s); the full pipeline run below returns and
    // persists metadata anyway.
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
    // Record the failure and stop: leave the item in 'error' (not auto-retried)
    // and don't rethrow, so the queue message acks cleanly and the self-drain
    // continuation isn't lost (which previously stranded items in 'fetching').
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await env.DB.prepare(
      "UPDATE item SET status = 'error', error = ?, retry_count = retry_count + 1 WHERE id = ?",
    )
      .bind(msg.slice(0, 4000), itemId)
      .run();
    console.error("pipeline item failed", itemId, msg);
  }
}

async function persistMetadata(env: Env, itemId: number, m: PipelineResult["metadata"]): Promise<void> {
  await persistItemMetadata(env, itemId, m);
}

async function persistResult(env: Env, itemId: number, r: PipelineResult): Promise<void> {
  await persistMetadata(env, itemId, r.metadata);
  // Link the item to its YouTube channel feed for subscriber-demand signals
  // (derived from the pipeline result instead of a separate metadata fetch).
  await linkItemFeed(env, itemId, youtubeChannelFeed(r.metadata.channel_id));

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
