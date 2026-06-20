import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "../env";
import { getBilibiliCookie } from "../lib/biliAuth";

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
  // Spin down quickly after a job so per-item instances don't linger against
  // the container max_instances cap. With queue max_concurrency == max_instances
  // (1 container per concurrent job), a long idle window would let a just-
  // finished instance overlap the next job and trip "no Container instance
  // available" 503s — so keep this short.
  sleepAfter = "5s";

  // Secrets/config the container needs are injected as container env vars.
  override envVars = {
    GEMINI_API_KEY: this.env.GEMINI_API_KEY,
    GEMINI_BASE_URL: this.env.LLM_BASE_URL,
    GEMINI_MODEL: this.env.LLM_MODEL,
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
    // Number of Cloudflare WARP SOCKS5 proxies entrypoint.sh brings up; yt-dlp
    // rotates through them (then `direct`) to dodge Bilibili IP risk-control.
    WARP_INSTANCES: this.env.WARP_INSTANCES ?? "2",
    // Optional single proxy override (used only when PROXY_URLS/WARP is unset).
    YT_DLP_PROXY: this.env.YT_DLP_PROXY ?? "",
  };
}

export interface PipelineJob {
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
  summary?: Record<string, unknown> | null;
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

export interface ChunkOut {
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
  summary: { model: string; prompt_version: string; markdown: string; structured: Record<string, unknown> } | null;
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
  event: "progress" | "result" | "error";
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
): Promise<PipelineResult> {
  const key = containerKey(env, `job-${job.item_id}`);
  if (job.platform === "bilibili" && !job.bilibili_cookie) {
    job = { ...job, bilibili_cookie: await getBilibiliCookie(env) };
  }
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

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let result: PipelineResult | null = null;
  let errorMsg: string | null = null;

  const handle = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: ProgressEvent;
    try {
      evt = JSON.parse(trimmed) as ProgressEvent;
    } catch {
      return;
    }
    if (evt.event === "result") result = evt.result ?? null;
    else if (evt.event === "error") {
      errorMsg = evt.message ?? "pipeline error";
      await onProgress(evt);
    } else await onProgress(evt);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      await handle(line);
    }
  }
  await handle(buf); // terminal line without a trailing newline

  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error("pipeline stream ended without a result");
  return result;
}

export interface FeedEntryOut {
  external_id: string | null;
  title: string | null;
  url: string;
  duration_s: number | null;
  published: string | null;
}

// Enumerate a channel/playlist's recent uploads via the container's yt-dlp.
// Used by subscription polling to go beyond the ~15 entries a channel's RSS
// feed exposes (the Worker can't run yt-dlp itself).
export async function fetchFeedEntries(
  env: Env,
  source_url: string,
  limit = 300,
): Promise<FeedEntryOut[]> {
  const instance = getContainer(env.PIPELINE_CONTAINER, containerKey(env, "feed"));
  const res = await instance.fetch(
    new Request("http://pipeline/feed_entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_url, limit }),
    }),
  );
  if (!res.ok) throw new Error(`feed_entries container ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
  const instance = getContainer(env.PIPELINE_CONTAINER, containerKey(env, `meta-${platform}`));
  const res = await instance.fetch(
    new Request("http://pipeline/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_url, platform, bilibili_cookie }),
    }),
  );
  if (!res.ok) throw new Error(`metadata container ${res.status}`);
  return (await res.json()) as PipelineResult["metadata"];
}
