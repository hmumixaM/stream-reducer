import type { Env, PipelineMessage } from "../env";
import { first, type ItemRow } from "../db";
import { isoNow } from "../lib/crypto";
import { persistItemMetadata, linkItemFeed, youtubeChannelFeed, cacheThumbnail } from "../lib/ingest";
import { runPipeline, runPipelineStreaming, type JsonObject, type PipelineResult, type ProgressEvent } from "./container";
import { pollSubscription } from "./subscriptions";
import { buildGraph } from "./graph_build";

export async function handleMessage(env: Env, msg: PipelineMessage): Promise<void> {
  switch (msg.kind) {
    case "process":
      return processNextQueuedItem(env);
    case "resummarize":
      return processItem(env, msg.item_id, true);
    case "structured_backfill":
      return backfillStructuredItem(env, msg.item_id, "structured_backfill");
    case "headline_backfill":
      return backfillStructuredItem(env, msg.item_id, "headline_backfill");
    case "infographic":
      return generateInfographic(env, msg.item_id);
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

function cleanGeneratedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

// An item still 'fetching'/'transcribing'/'summarizing' after this long was
// orphaned by a Worker restart/eviction (a queue invocation caps at ~15 min),
// so it's safe to reclaim. Errors are NOT auto-reclaimed (need explicit retry).
const STALE_IN_PROGRESS_MS = 20 * 60 * 1000;
const IN_PROGRESS = ["fetching", "transcribing", "summarizing"];
// Stop reclaiming an item that has been orphaned this many times (e.g. content
// too long to finish within the invocation budget) so it can't loop forever.
const MAX_RECLAIM = 3;

function staleCutoff(): string {
  return new Date(Date.now() - STALE_IN_PROGRESS_MS).toISOString();
}

// A 503 from the container DO means no free instance right now (all slots busy /
// still provisioning) — transient, not a real job failure. Re-queue instead of
// erroring so a capacity blip doesn't permanently fail items. The
// blockConcurrencyWhile/DO-reset case is the same class: a cold container that
// took too long to provision (image pull/boot > the DO startup window, common
// right after a deploy or CONTAINER_GEN bump) gets reset — retrying once it's
// warm succeeds, so treat it as transient too.
function isTransientCapacity(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("container 503") ||
    m.includes("no container instance available") ||
    m.includes("currently provisioning") ||
    m.includes("blockconcurrencywhile") ||
    m.includes("durable object was reset") ||
    m.includes("durable object reset because its code was updated")
  );
}

// SQL predicate (and its bind params) for an item that can be claimed: a fresh
// 'queued' item, or one orphaned in-progress past the cutoff and under the
// reclaim cap.
function claimableClause(): string {
  const ph = IN_PROGRESS.map(() => "?").join(",");
  return `(status = 'queued' OR (status IN (${ph}) AND started_at < ? AND retry_count < ${MAX_RECLAIM}))`;
}
function claimableBinds(cutoff: string): unknown[] {
  return [...IN_PROGRESS, cutoff];
}

// An item orphaned in-progress past the stale cutoff that has ALSO exhausted
// its automatic reclaims is, by definition, no longer claimable (see
// claimableClause) — without this it would sit in 'summarizing'/'fetching'
// forever. This happens when the queue consumer is hard-killed (e.g.
// exceededCpu) before its catch block can record an error. Flip such items to a
// terminal, user-visible 'error' so they surface in the queue as failed (and
// can be retried) instead of hanging silently.
export async function failStrandedItems(env: Env): Promise<void> {
  const ph = IN_PROGRESS.map(() => "?").join(",");
  const cutoff = staleCutoff();
  const res = await env.DB.prepare(
    `UPDATE item SET status = 'error',
       error = 'pipeline worker was killed before completing (CPU/time limit) and exhausted automatic reclaims — retry to reprocess',
       completed_at = ?, progress_stage = NULL, progress_pct = NULL,
       progress_detail = NULL, progress_updated_at = NULL
     WHERE status IN (${ph}) AND started_at < ? AND retry_count >= ${MAX_RECLAIM}
     RETURNING id`,
  )
    .bind(isoNow(), ...IN_PROGRESS, cutoff)
    .all<{ id: number }>();
  const reaped = (res.results ?? []).map((r) => r.id);
  if (reaped.length) console.error("failStrandedItems reaped stranded items to 'error'", reaped);
}

async function processNextQueuedItem(env: Env): Promise<void> {
  // Clear out items that can never be reclaimed again (orphaned + over the
  // reclaim cap) before claiming fresh work, so they don't hang forever.
  await failStrandedItems(env);
  const item = await claimNextQueuedItem(env);
  if (!item) return;
  // Enqueue the continuation BEFORE processing. concurrency=1 keeps it from
  // overlapping, and it ensures the chain survives even if this invocation is
  // evicted mid-job (which previously stalled the whole queue).
  await enqueueNextIfWork(env);
  await processClaimedItem(env, item, false);
}

// Reclaim the next claimable item: a queued one, or one stuck in-progress past
// the stale cutoff (orphaned by a restart). Uses a conditional UPDATE so two
// concurrent claims can't grab the same item.
async function claimNextQueuedItem(env: Env): Promise<ItemRow | null> {
  const cutoff = staleCutoff();
  const clause = claimableClause();
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await first<ItemRow>(
      env.DB.prepare(
        `SELECT * FROM item WHERE ${clause}
          ORDER BY (CASE WHEN status = 'queued' THEN 0 ELSE 1 END),
                   priority_score DESC, request_count DESC, enqueued_at ASC
          LIMIT 1`,
      ).bind(...claimableBinds(cutoff)),
    );
    if (!candidate) return null;

    // Reclaiming an orphaned in-progress item counts as an attempt (so it can't
    // loop forever); a fresh queued claim does not.
    const res = await env.DB.prepare(
      `UPDATE item SET status = 'fetching', started_at = ?, error = NULL,
         progress_stage = NULL, progress_pct = NULL, progress_detail = NULL, progress_updated_at = NULL,
         retry_count = retry_count + (CASE WHEN status = 'queued' THEN 0 ELSE 1 END)
        WHERE id = ? AND ${clause}`,
    )
      .bind(isoNow(), candidate.id, ...claimableBinds(cutoff))
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
  const more = await first<{ id: number }>(
    env.DB.prepare(`SELECT id FROM item WHERE ${claimableClause()} LIMIT 1`).bind(...claimableBinds(cutoff)),
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
        view_count: item.view_count,
        like_count: item.like_count,
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

// Generate a shared, on-demand infographic poster: render the existing
// structured summary into an image with the image model and store it in R2.
// Result row (item_infographic) is keyed by item and shown to every user.
async function generateInfographic(env: Env, itemId: number): Promise<void> {
  const fail = async (msg: string) => {
    await env.DB.prepare(
      "UPDATE item_infographic SET status = 'error', error = ?, updated_at = ? WHERE item_id = ?",
    ).bind(msg.slice(0, 2000), isoNow(), itemId).run();
  };

  const item = await first<ItemRow>(env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(itemId));
  const summary = await first<{ structured: string }>(
    env.DB.prepare("SELECT structured FROM summary WHERE item_id = ?").bind(itemId),
  );
  if (!item || !summary) return fail("item has no summary to render");

  await env.DB.prepare(
    "UPDATE item_infographic SET status = 'processing', error = NULL, updated_at = ? WHERE item_id = ?",
  ).bind(isoNow(), itemId).run();

  try {
    const structured = JSON.parse(summary.structured || "{}") as JsonObject;
    const result = await runPipeline(env, {
      item_id: itemId,
      source_url: item.source_url,
      platform: item.platform,
      mode: "infographic",
      summary: structured,
      item: {
        title: item.title,
        author: item.author,
        description: item.description,
        duration_s: item.duration_s,
        published_at: item.published_at,
        view_count: item.view_count,
        like_count: item.like_count,
      },
    });
    if (result.error || !result.infographic) throw new Error(result.error || "no infographic produced");

    const ig = result.infographic;
    const ext = ig.mime_type.includes("jpeg") || ig.mime_type.includes("jpg") ? "jpg" : "png";
    const key = `infographic/${itemId}.${ext}`;
    const bytes = Uint8Array.from(atob(ig.image_b64), (ch) => ch.charCodeAt(0));
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: ig.mime_type } });

    await env.DB.prepare(
      `UPDATE item_infographic SET status = 'done', model = ?, image_key = ?, mime_type = ?,
         total_tokens = ?, cost_usd = ?, error = NULL, updated_at = ? WHERE item_id = ?`,
    )
      .bind(ig.model, key, ig.mime_type, ig.total_tokens, ig.cost_usd, isoNow(), itemId)
      .run();

    // Roll the image stage's cost/tokens into the item totals (same as backfills).
    const totals = await persistStageRuns(env, itemId, result.stages);
    await env.DB.prepare(
      `UPDATE item SET total_processing_ms = total_processing_ms + ?,
         total_api_requests = total_api_requests + ?,
         total_tokens = total_tokens + ?,
         total_cost_usd = total_cost_usd + ?
       WHERE id = ?`,
    )
      .bind(totals.totalMs, totals.totalReq, totals.totalTok, totals.totalCost, itemId)
      .run();
  } catch (err) {
    await fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    throw err;
  }
}

async function backfillStructuredItem(
  env: Env,
  itemId: number,
  mode: "structured_backfill" | "headline_backfill",
): Promise<void> {
  const item = await first<ItemRow>(env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(itemId));
  const summary = await first<{ model: string; prompt_version: string; markdown: string; structured: string }>(
    env.DB.prepare("SELECT model, prompt_version, markdown, structured FROM summary WHERE item_id = ?").bind(itemId),
  );
  if (!item || !summary) return;

  try {
    const structured = JSON.parse(summary.structured || "{}") as JsonObject;
    const result = await runPipeline(env, {
      item_id: itemId,
      source_url: item.source_url,
      platform: item.platform,
      mode,
      summary: structured,
      item: {
        title: item.title,
        author: item.author,
        description: item.description,
        duration_s: item.duration_s,
        published_at: item.published_at,
        view_count: item.view_count,
        like_count: item.like_count,
      },
    });
    if (result.error || !result.summary) throw new Error(result.error || "no structured summary produced");

    if (mode === "headline_backfill") {
      // Only the headline/subhead changed; keep the existing markdown/model.
      await env.DB.prepare("UPDATE summary SET structured = ? WHERE item_id = ?")
        .bind(JSON.stringify(result.summary.structured), itemId)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE summary SET model = ?, prompt_version = ?, markdown = ?, structured = ?
          WHERE item_id = ?`,
      )
        .bind(
          result.summary.model,
          result.summary.prompt_version,
          result.summary.markdown,
          JSON.stringify(result.summary.structured),
          itemId,
        )
        .run();
    }
    await persistHeadlineFields(env, itemId, result.summary.structured);
    const totals = await persistStageRuns(env, itemId, result.stages);
    await env.DB.prepare(
      `UPDATE item SET total_processing_ms = total_processing_ms + ?,
         total_api_requests = total_api_requests + ?,
         total_tokens = total_tokens + ?,
         total_cost_usd = total_cost_usd + ?,
         error = NULL
       WHERE id = ?`,
    )
      .bind(totals.totalMs, totals.totalReq, totals.totalTok, totals.totalCost, itemId)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await env.DB.prepare("UPDATE item SET error = ? WHERE id = ?").bind(msg.slice(0, 4000), itemId).run();
    throw err;
  }
}

async function processItem(env: Env, itemId: number, resummarize = false): Promise<void> {
  const item = await first<ItemRow>(env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(itemId));
  if (!item) return;

  await env.DB.prepare(
    `UPDATE item SET status = 'fetching', started_at = ?, error = NULL,
       progress_stage = NULL, progress_pct = NULL, progress_detail = NULL, progress_updated_at = NULL
     WHERE id = ?`,
  )
    .bind(isoNow(), itemId)
    .run();
  return processClaimedItem(env, { ...item, status: "fetching", error: null }, resummarize);
}

// Map a streamed pipeline stage to the item's coarse status.
const STAGE_STATUS: Record<string, string> = {
  download: "fetching",
  transcribe: "transcribing",
  summarize: "summarizing",
};

// "45% · 2.4 MB/s · ETA 12s" for downloads, "chunk 3/10" for transcription,
// or an explicit detail (e.g. summarize section names).
function progressDetail(evt: ProgressEvent): string | null {
  if (typeof evt.detail === "string" && evt.detail) return evt.detail;
  if (evt.stage === "download") {
    const parts = [
      evt.pct != null ? `${evt.pct}%` : null,
      evt.speed ? `${(evt.speed / 1e6).toFixed(1)} MB/s` : null,
      evt.eta != null ? `ETA ${evt.eta}s` : null,
    ].filter((part): part is string => part !== null);
    return parts.join(" · ") || null;
  }
  if (evt.stage === "transcribe" && evt.chunk_count) {
    return `chunk ${evt.chunk_done}/${evt.chunk_count}`;
  }
  return null;
}

async function processClaimedItem(env: Env, item: ItemRow, resummarize = false): Promise<void> {
  const itemId = item.id;
  const runStart = Date.now();
  try {
    const transcript = await loadResummarizeTranscript(env, itemId, resummarize);
    const job = buildPipelineJob(item, resummarize, transcript);
    const result = await executePipeline(env, itemId, job, resummarize);

    if (result.excluded) {
      await persistExcludedResult(env, itemId, result);
      return;
    }
    await persistCompletedPipeline(env, itemId, result);
  } catch (err) {
    await handlePipelineFailure(env, itemId, runStart, err);
  }
}

type ClaimedPipelineJob = Parameters<typeof runPipeline>[1];

async function loadResummarizeTranscript(
  env: Env,
  itemId: number,
  resummarize: boolean,
): Promise<ClaimedPipelineJob["transcript"]> {
  if (!resummarize) return null;

  const transcript = await first<{ language: string | null; source: string; segments: string; text: string }>(
    env.DB.prepare("SELECT language, source, segments, text FROM transcript WHERE item_id = ?").bind(itemId),
  );
  if (!transcript) return null;

  return {
    language: transcript.language,
    source: transcript.source,
    segments: JSON.parse(transcript.segments || "[]"),
    text: transcript.text,
  };
}

function buildPipelineJob(
  item: ItemRow,
  resummarize: boolean,
  transcript: ClaimedPipelineJob["transcript"],
): ClaimedPipelineJob {
  return {
    item_id: item.id,
    source_url: item.source_url,
    platform: item.platform,
    mode: resummarize ? "resummarize" : "process",
    transcript,
    item: {
      title: item.title,
      author: item.author,
      description: item.description,
      duration_s: item.duration_s,
      published_at: item.published_at,
      view_count: item.view_count,
      like_count: item.like_count,
    },
  };
}

async function executePipeline(
  env: Env,
  itemId: number,
  job: ClaimedPipelineJob,
  resummarize: boolean,
): Promise<PipelineResult> {
  if (resummarize) return runPipeline(env, job);

  return runPipelineStreaming(
    env,
    job,
    createProgressHeartbeat(env, itemId),
    (event) => persistPipelinePartial(env, itemId, event),
  );
}

function createProgressHeartbeat(env: Env, itemId: number): (evt: ProgressEvent) => Promise<void> {
  let lastWrite = 0;
  let lastStage = "";

  return async (evt: ProgressEvent): Promise<void> => {
    if (evt.event !== "progress") return;
    const stage = evt.stage || "";
    const now = Date.now();
    const stageChanged = stage !== lastStage;
    if (!stageChanged && now - lastWrite < 1500) return;

    lastWrite = now;
    lastStage = stage;
    await persistProgressHeartbeat(env, itemId, evt, stage);
  };
}

async function persistProgressHeartbeat(
  env: Env,
  itemId: number,
  evt: ProgressEvent,
  stage: string,
): Promise<void> {
  const pct = typeof evt.pct === "number" ? evt.pct : null;
  const detail = progressDetail(evt);
  try {
    await env.DB.prepare(
      `UPDATE item SET status = COALESCE(?, status), progress_stage = ?, progress_pct = ?,
         progress_detail = ?, progress_updated_at = ? WHERE id = ?`,
    )
      .bind(STAGE_STATUS[stage] ?? null, stage || null, pct, detail, isoNow(), itemId)
      .run();
  } catch (err) {
    console.error("heartbeat bind failed", itemId, JSON.stringify({ evt, pct, detail }).slice(0, 2000));
    throw err;
  }
}

async function persistPipelinePartial(env: Env, itemId: number, evt: ProgressEvent): Promise<void> {
  if (evt.metadata) await persistMetadata(env, itemId, evt.metadata);
  if (evt.transcript) await persistTranscript(env, itemId, evt.transcript);
}

async function persistTranscript(
  env: Env,
  itemId: number,
  transcript: NonNullable<ProgressEvent["transcript"]>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO transcript (item_id, language, source, segments, text)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET language=excluded.language, source=excluded.source,
       segments=excluded.segments, text=excluded.text`,
  )
    .bind(itemId, transcript.language, transcript.source, JSON.stringify(transcript.segments), transcript.text)
    .run();
}

async function persistExcludedResult(env: Env, itemId: number, result: PipelineResult): Promise<void> {
  if (result.metadata) await persistMetadata(env, itemId, result.metadata);
  await env.DB.prepare(
    "UPDATE item SET status = 'excluded', error = ?, completed_at = ?, retry_count = ? WHERE id = ?",
  )
    .bind((result.error || "members-only").slice(0, 500), isoNow(), MAX_RECLAIM, itemId)
    .run();
  await env.DB.prepare("DELETE FROM user_item WHERE item_id = ?").bind(itemId).run();
  await env.DB.prepare("DELETE FROM comment WHERE item_id = ?").bind(itemId).run();
  await env.DB.prepare("DELETE FROM highlight WHERE item_id = ?").bind(itemId).run();
}

async function persistCompletedPipeline(env: Env, itemId: number, result: PipelineResult): Promise<void> {
  if (result.error) throw new Error(result.error);

  await persistResultWithDiagnostics(env, itemId, result);
  await embedChunks(env, itemId);
  await markItemDone(env, itemId);
}

async function persistResultWithDiagnostics(env: Env, itemId: number, result: PipelineResult): Promise<void> {
  try {
    await persistResult(env, itemId, result);
  } catch (err) {
    console.error("persistResult failed", itemId, JSON.stringify(resultDiagnostic(result)).slice(0, 4000));
    throw err;
  }
}

function resultDiagnostic(result: PipelineResult) {
  return {
    metadata: result.metadata,
    media: result.media ? { ...result.media, audio_b64: result.media.audio_b64 ? "<b64>" : null } : null,
    summary: result.summary
      ? {
          model: result.summary.model,
          prompt_version: result.summary.prompt_version,
          markdown_type: typeof result.summary.markdown,
          structured: result.summary.structured,
        }
      : null,
    transcript: result.transcript
      ? {
          language: result.transcript.language,
          source: result.transcript.source,
          text_type: typeof result.transcript.text,
          seg0: result.transcript.segments[0],
        }
      : null,
    chunk0: result.chunks[0],
    chunk_count: result.chunks.length,
  };
}

async function markItemDone(env: Env, itemId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE item SET status = 'done', completed_at = ?, error = NULL,
       progress_stage = NULL, progress_pct = NULL, progress_detail = NULL, progress_updated_at = NULL
     WHERE id = ?`,
  )
    .bind(isoNow(), itemId)
    .run();
  await env.DB.prepare("UPDATE user_item SET personal_status = 'done' WHERE item_id = ?").bind(itemId).run();
}

async function handlePipelineFailure(
  env: Env,
  itemId: number,
  runStart: number,
  err: unknown,
): Promise<void> {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (isTransientCapacity(msg)) {
    await requeueTransientPipelineItem(env, itemId);
    console.warn("pipeline item deferred — no container slot, re-queued", itemId);
    throw err;
  }

  await markItemErrored(env, itemId, msg);
  console.error(`pipeline item failed item=${itemId} ms=${Date.now() - runStart} msg=${msg}`);
}

async function requeueTransientPipelineItem(env: Env, itemId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE item SET status = 'queued', error = NULL,
       progress_stage = NULL, progress_pct = NULL, progress_detail = NULL, progress_updated_at = NULL
     WHERE id = ?`,
  )
    .bind(itemId)
    .run();
}

async function markItemErrored(env: Env, itemId: number, msg: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE item SET status = 'error', error = ?, retry_count = retry_count + 1,
       progress_stage = NULL, progress_pct = NULL, progress_detail = NULL, progress_updated_at = NULL
     WHERE id = ?`,
  )
    .bind(msg.slice(0, 4000), itemId)
    .run();
}

async function persistMetadata(env: Env, itemId: number, m: PipelineResult["metadata"]): Promise<void> {
  // Mirror the cover image into R2 and persist the /media path (see cacheThumbnail).
  const cached = await cacheThumbnail(env, itemId, m.thumbnail);
  await persistItemMetadata(env, itemId, cached ? { ...m, thumbnail: cached } : m);
}

async function persistHeadlineFields(env: Env, itemId: number, structured: JsonObject): Promise<void> {
  const headline = cleanGeneratedText(structured.headline);
  const subhead = cleanGeneratedText(structured.subhead);
  await env.DB.prepare(
    `UPDATE item SET headline = COALESCE(?, headline), subhead = COALESCE(?, subhead)
      WHERE id = ?`,
  )
    .bind(headline, subhead, itemId)
    .run();
}

async function persistStageRuns(
  env: Env,
  itemId: number,
  stages: PipelineResult["stages"],
): Promise<{ totalMs: number; totalReq: number; totalTok: number; totalCost: number }> {
  let totalMs = 0, totalReq = 0, totalTok = 0, totalCost = 0;
  for (const s of stages) {
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
  return { totalMs, totalReq, totalTok, totalCost };
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
    await persistHeadlineFields(env, itemId, r.summary.structured);
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
  const { totalMs, totalReq, totalTok, totalCost } = await persistStageRuns(env, itemId, r.stages);
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
