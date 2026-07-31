import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "../env";
import { getBilibiliCookie } from "../lib/biliAuth";
import { errorMessage, isTransientCapacity } from "./transient";

// Container DO instances run the image they were CREATED with and are reused by
// id across deploys, so a long-lived instance can keep running a stale image
// after a new deploy (which left fixes from not taking effect). Suffixing the
// instance key with CONTAINER_GEN lets a deploy that bumps that var force every
// job onto a brand-new instance (= the freshly built image).
export function containerKey(env: Env, base: string): string {
  return `${base}-g${env.CONTAINER_GEN ?? "0"}`;
}

// Container-enabled Durable Object that runs the Python pipeline image
// (yt-dlp + ffmpeg + summarize). The Worker controls one instance per job.
export class PipelineContainer extends Container<Env> {
  // The Python service inside the image listens here (see cf/pipeline/server.py).
  defaultPort = 8080;
  // Keep a just-finished instance warm briefly so that when the SAME item is
  // redelivered for a retry (watchdog/stream-break/transient), it lands back on
  // its still-running instance (key = `job-<id>`) instead of paying a full cold
  // boot of the heavy image. The previous 5s was too short to survive the queue
  // redelivery window, so every retry cold-started — and on the ¼-vCPU `basic`
  // instance those slow boots blow the Durable Object startup budget
  // (blockConcurrencyWhile) and get reset/SIGTERM'd, feeding a churn loop.
  // Kept modest (not minutes) because per-item keys mean a lingering finished
  // instance can't be reused by a DIFFERENT item — it only holds a slot against
  // the max_instances cap, so too-long a window would trip "no Container
  // instance available" 503s.
  sleepAfter = "30s";

  // Secrets/config the container needs are injected as container env vars.
  override envVars = {
    GEMINI_API_KEY: this.env.GEMINI_API_KEY,
    GEMINI_BASE_URL: this.env.LLM_BASE_URL,
    GEMINI_MODEL: this.env.LLM_MODEL,
    // Backup summarize model: a summarize call that times out/errors on
    // GEMINI_MODEL is retried once against this (same proxy). Empty = disabled.
    GEMINI_MODEL_FALLBACK: this.env.LLM_MODEL_FALLBACK ?? "",
    // Image generation: model + a dedicated AI Studio key (falls back to
    // GEMINI_API_KEY inside the container when not set).
    GEMINI_IMAGE_MODEL: this.env.LLM_MODEL_INFOGRAPHIC,
    GEMINI_IMAGE_API_KEY: this.env.GEMINI_IMAGE_API_KEY ?? "",
    OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
    STT_MODEL: this.env.STT_MODEL,
    // Bilibili web cookies for yt-dlp (materialized into a cookie file inside
    // the container) — required to clear HTTP 412 risk control on downloads.
    // This is the static seed; the per-job request body carries the freshest
    // (auto-refreshed) cookie and wins inside the container.
    BILIBILI_COOKIE: this.env.BILIBILI_COOKIE ?? "",
    // Logged-in YouTube web cookies ("name=value; …") for yt-dlp, materialized
    // into a cookie file inside the container — clears YouTube's "confirm you're
    // not a bot" wall and age/region gates so downloads are more reliable.
    YOUTUBE_COOKIE: this.env.YOUTUBE_COOKIE ?? "",
    // Number of Cloudflare WARP SOCKS5 proxies entrypoint.sh brings up; yt-dlp
    // rotates through them (then `direct`) to dodge Bilibili IP risk-control.
    WARP_INSTANCES: this.env.WARP_INSTANCES ?? "2",
    // Optional single proxy override (used only when PROXY_URLS/WARP is unset).
    YT_DLP_PROXY: this.env.YT_DLP_PROXY ?? "",
  };
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

interface PipelineJob {
  item_id: number;
  source_url: string;
  platform: string;
  // resummarize re-runs only the summary using a provided transcript.
  // structured_backfill re-generates structured summary fields from stored summary JSON.
  // headline_backfill re-generates only the headline/subhead from stored summary JSON.
  // infographic renders an image poster from stored summary JSON (image model).
  mode: "process" | "resummarize" | "structured_backfill" | "headline_backfill" | "infographic";
  // Freshest (auto-refreshed) Bilibili cookie, attached per-job so the container
  // uses the current cookie instead of the static deploy-time secret.
  bilibili_cookie?: string;
  transcript?: { language: string | null; source: string; segments: unknown[]; text: string } | null;
  summary?: JsonObject | null;
  // When set, the summary is regenerated in this language (on-demand translation).
  target_lang?: string;
  // Caller-supplied stored metadata used as summary context (title, show notes,
  // show/author, date, views). Authoritative for sources whose URL exposes no
  // scrapeable metadata of its own (e.g. podcast/RSS audio enclosures), and a
  // re-fetch avoidance for resummarize/translate.
  item?: {
    title?: string | null;
    author?: string | null;
    description?: string | null;
    duration_s?: number | null;
    published_at?: string | null;
    view_count?: number | null;
    like_count?: number | null;
  };
}

interface ChunkOut {
  source: string;
  field: string;
  chunk_index: number;
  text: string;
  start_s: number | null;
  end_s: number | null;
  char_start: number | null;
  char_end: number | null;
  content_hash: string;
}

export interface PipelineResult {
  metadata: {
    title?: string | null;
    author?: string | null;
    description?: string | null;
    duration_s?: number | null;
    published_at?: string | null;
    thumbnail?: string | null;
    external_id?: string | null;
    view_count?: number | null;
    like_count?: number | null;
    dislike_count?: number | null;
    channel_id?: string | null;
  };
  transcript: { language: string | null; source: string; segments: unknown[]; text: string } | null;
  summary: { model: string; prompt_version: string; markdown: string; structured: JsonObject } | null;
  // Present only for mode: "infographic". The base64 image plus usage/cost.
  infographic?: { image_b64: string; mime_type: string; model: string; total_tokens: number; cost_usd: number } | null;
  chunks: ChunkOut[];
  media: { bytes: number; duration_s: number | null; audio_b64: string | null; format: string | null };
  stages: { stage: string; provider: string | null; model: string | null; duration_ms: number; request_count: number; total_tokens: number; cost_usd: number; error?: string | null }[];
  error?: string | null;
  // Set when the container deliberately skipped the item (membership/paid-gated
  // content). The Worker marks it 'excluded' — a terminal, non-retried state.
  excluded?: boolean;
}

// Run a job in its own container instance (keyed by item). Per-item isolation
// means a slow or hung job can't block the next one (a single shared instance
// caused head-of-line blocking); instances spin down fast via `sleepAfter` to
// stay under the max_instances cap.
export async function runPipeline(env: Env, job: PipelineJob): Promise<PipelineResult> {
  const key = containerKey(
    env,
    job.target_lang
      ? `tr-${job.item_id}-${job.target_lang}`
      : job.mode === "infographic"
        ? `ig-${job.item_id}`
        : `job-${job.item_id}`,
  );
  // Attach the freshest Bilibili cookie (from KV) so the container's yt-dlp uses
  // the auto-refreshed value rather than the static deploy-time env secret.
  if (job.platform === "bilibili" && !job.bilibili_cookie) {
    job = { ...job, bilibili_cookie: await getBilibiliCookie(env) };
  }
  const instance = getContainer(env.PIPELINE_CONTAINER, key);
  const res = await instance.fetch(
    new Request("http://pipeline/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pipeline container ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as PipelineResult;
}

// A streamed pipeline progress event (see cf/pipeline/server.py /process_stream).
export interface ProgressEvent {
  event: "progress" | "result" | "error" | "partial" | "log";
  // For event === "log": a forwarded container-side `pipeline` logger record.
  // Container stdout isn't captured by Workers observability, so these are
  // re-emitted to the Worker console (tagged with the item id) to make the
  // inside of a pipeline run visible.
  level?: string;
  logger?: string;
  stage?: string;
  status?: string;
  pct?: number | null;
  speed?: number | null;
  eta?: number | null;
  downloaded?: number | null;
  total?: number | null;
  chunk_done?: number;
  chunk_count?: number;
  detail?: string;
  message?: string;
  result?: PipelineResult;
  // Partial stage content streamed mid-run (event === "partial"): e.g. the
  // transcript + metadata as soon as transcribe finishes, so the UI shows them
  // before summarize completes.
  partial?: string;
  metadata?: PipelineResult["metadata"];
  transcript?: PipelineResult["transcript"];
}

// Like runPipeline, but consumes the container's NDJSON /process_stream so the
// caller can observe live stage/%/errors while the job runs. Returns the final
// PipelineResult (or throws with the captured reason). If @cloudflare/containers
// buffers the body, progress simply arrives in one burst at the end (acceptable
// degradation to runPipeline's behavior).
export async function runPipelineStreaming(
  env: Env,
  job: PipelineJob,
  onProgress: (evt: ProgressEvent) => void | Promise<void>,
  onPartial?: (evt: ProgressEvent) => void | Promise<void>,
): Promise<PipelineResult> {
  const resolvedJob = await withBilibiliCookie(env, job);
  const reader = await openPipelineStream(env, resolvedJob);
  const state: PipelineStreamState = {
    result: null,
    errorMsg: null,
    lastStage: null,
    lastDetail: null,
  };
  const idleMs = Number(env.PIPELINE_IDLE_MS ?? "240000");

  await readNdjsonLines(
    reader,
    idleMs,
    createStreamEventHandler(resolvedJob, state, onProgress, onPartial),
    () => pipelineIdleContext(state),
  );

  if (state.errorMsg) throw new Error(state.errorMsg);
  if (!state.result) throw new Error("pipeline stream ended without a result");
  return state.result;
}

interface PipelineStreamState {
  result: PipelineResult | null;
  errorMsg: string | null;
  lastStage: string | null;
  lastDetail: string | null;
}

async function withBilibiliCookie(env: Env, job: PipelineJob): Promise<PipelineJob> {
  if (job.platform !== "bilibili" || job.bilibili_cookie) return job;
  return { ...job, bilibili_cookie: await getBilibiliCookie(env) };
}

async function openPipelineStream(
  env: Env,
  job: PipelineJob,
): Promise<ReadableStreamDefaultReader<string>> {
  const key = containerKey(env, `job-${job.item_id}`);
  const instance = getContainer(env.PIPELINE_CONTAINER, key);
  const res = await instance.fetch(
    new Request("http://pipeline/process_stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    }),
  );
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : "";
    throw new Error(`pipeline container ${res.status}: ${text.slice(0, 500)}`);
  }

  return res.body.pipeThrough(new TextDecoderStream()).getReader();
}

function createStreamEventHandler(
  job: PipelineJob,
  state: PipelineStreamState,
  onProgress: (evt: ProgressEvent) => void | Promise<void>,
  onPartial?: (evt: ProgressEvent) => void | Promise<void>,
): (line: string) => Promise<void> {
  return async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: ProgressEvent;
    try {
      evt = JSON.parse(trimmed) as ProgressEvent;
    } catch {
      return;
    }
    if (typeof evt.stage === "string" && evt.stage) state.lastStage = evt.stage;
    if (typeof evt.detail === "string" && evt.detail) state.lastDetail = evt.detail;
    if (evt.event === "result") state.result = evt.result ?? null;
    else if (evt.event === "error") {
      state.errorMsg = evt.message ?? "pipeline error";
      await onProgress(evt);
    } else if (evt.event === "partial") {
      if (onPartial) await onPartial(evt);
    } else if (evt.event === "log") {
      // Surface container-internal logs in Workers observability, tagged with
      // the item id so a run's full timeline (stages, LLM latency, failures) is
      // queryable. Warnings/errors go to console.error so they're filterable.
      const msg = `[container item=${job.item_id}] ${evt.message ?? ""}`;
      if (evt.level === "ERROR" || evt.level === "CRITICAL" || evt.level === "WARNING") console.error(msg);
    } else await onProgress(evt);
  };
}

async function readNdjsonLines(
  reader: ReadableStreamDefaultReader<string>,
  idleMs: number,
  handleLine: (line: string) => Promise<void>,
  idleContext: () => string,
): Promise<void> {
  let pending = "";
  for (;;) {
    const { value, done } = await readWithIdleTimeout(reader, idleMs, idleContext);
    if (done) break;
    const split = splitNdjsonChunk(pending, value);
    pending = split.pending;
    for (const line of split.lines) await handleLine(line);
  }
  await handleLine(pending);
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<string>,
  idleMs: number,
  idleContext: () => string,
): Promise<ReadableStreamReadResult<string>> {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<"idle">((resolve) => {
    idleTimer = setTimeout(() => resolve("idle"), idleMs);
  });
  const step = await Promise.race([reader.read(), idle]);
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  if (step !== "idle") return step;

  try {
    await reader.cancel();
  } catch {
    // ignore cancellation failures; the stall error below is the useful signal.
  }
  throw new Error(
    `pipeline stalled — no progress for ${Math.round(idleMs / 60000)}min${idleContext()}`,
  );
}

function pipelineIdleContext(state: PipelineStreamState): string {
  const stage = state.lastStage ? ` during ${state.lastStage}` : "";
  const detail = state.lastDetail ? ` (${state.lastDetail})` : "";
  return `${stage}${detail}`;
}

function splitNdjsonChunk(previousPending: string, chunk: string): { lines: string[]; pending: string } {
  const parts = chunk.split("\n");
  if (parts.length === 1) return { lines: [], pending: previousPending + chunk };

  return {
    lines: [previousPending + parts[0], ...parts.slice(1, -1)],
    pending: parts[parts.length - 1],
  };
}

interface FeedEntryOut {
  external_id: string | null;
  title: string | null;
  url: string;
  duration_s: number | null;
  published: string | null;
}

// Backoff between retries of a short aux container call. Generous on purpose: a
// blockConcurrencyWhile reset means a cold container blew the DO startup window,
// so the retry needs enough time for provisioning/image pull to actually finish.
const AUX_BACKOFF_MS = [5000, 15000];

// Short, idempotent container calls (feed enumeration, metadata) share the
// container pool with pipeline jobs, so they routinely catch infra blips: every
// slot busy (503) or a cold start reset by blockConcurrencyWhile. Both clear on
// their own and a retry lands on a warm/free instance, so absorb them here.
// Without this, one cold-start reset surfaced all the way up and marked an entire
// subscription 'error' (last_status='error', consecutive_failures++) even though
// nothing about the feed was actually broken.
async function auxContainerCall(
  env: Env,
  instanceKey: string,
  path: string,
  payload: unknown,
  label: string,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const instance = getContainer(env.PIPELINE_CONTAINER, containerKey(env, instanceKey));
      // Build a fresh Request per attempt: a Request body can only be read once.
      const res = await instance.fetch(
        new Request(`http://pipeline${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      if (res.ok) return res;
      throw new Error(`${label} container ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (err) {
      const msg = errorMessage(err);
      if (attempt > AUX_BACKOFF_MS.length || !isTransientCapacity(msg)) throw err;
      console.warn(`${label} container blip (attempt ${attempt}) — retrying: ${msg}`);
      await new Promise((resolve) => setTimeout(resolve, AUX_BACKOFF_MS[attempt - 1]));
    }
  }
}

// Enumerate a channel/playlist's recent uploads via the container's yt-dlp.
// Used by subscription polling to go beyond the ~15 entries a channel's RSS
// feed exposes (the Worker can't run yt-dlp itself).
export async function fetchFeedEntries(
  env: Env,
  source_url: string,
  limit = 300,
): Promise<FeedEntryOut[]> {
  const res = await auxContainerCall(env, "feed", "/feed_entries", { source_url, limit }, "feed_entries");
  const data = (await res.json()) as { entries?: FeedEntryOut[] };
  return data.entries ?? [];
}

// Fetch only metadata (used for fast metadata-first prioritization).
export async function fetchMetadata(
  env: Env,
  source_url: string,
  platform: string,
): Promise<PipelineResult["metadata"]> {
  const bilibili_cookie = platform === "bilibili" ? await getBilibiliCookie(env) : undefined;
  const res = await auxContainerCall(
    env,
    `meta-${platform}`,
    "/metadata",
    { source_url, platform, bilibili_cookie },
    "metadata",
  );
  return (await res.json()) as PipelineResult["metadata"];
}
