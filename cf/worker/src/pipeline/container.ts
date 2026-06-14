import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "../env";

// Container-enabled Durable Object that runs the Python pipeline image
// (yt-dlp + ffmpeg + summarize). The Worker controls one instance per job.
export class PipelineContainer extends Container<Env> {
  // The Python service inside the image listens here (see cf/pipeline/server.py).
  defaultPort = 8080;
  // Spin down after a short idle so we don't pay for idle compute.
  sleepAfter = "5m";

  // Secrets/config the container needs are injected as container env vars.
  override envVars = {
    GEMINI_API_KEY: this.env.GEMINI_API_KEY,
    GEMINI_BASE_URL: this.env.LLM_BASE_URL,
    GEMINI_MODEL: this.env.LLM_MODEL,
    OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
    STT_MODEL: this.env.STT_MODEL,
  };
}

export interface PipelineJob {
  item_id: number;
  source_url: string;
  platform: string;
  // resummarize re-runs only the summary using a provided transcript.
  mode: "process" | "resummarize";
  transcript?: { language: string | null; source: string; segments: unknown[]; text: string } | null;
  // When set, the summary is regenerated in this language (on-demand translation).
  target_lang?: string;
  // Caller-supplied metadata for resummarize/translate (avoids a re-fetch).
  item?: {
    title?: string | null;
    author?: string | null;
    description?: string | null;
    duration_s?: number | null;
    published_at?: string | null;
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
  chunks: ChunkOut[];
  media: { bytes: number; duration_s: number | null; audio_b64: string | null; format: string | null };
  stages: { stage: string; provider: string | null; model: string | null; duration_ms: number; request_count: number; total_tokens: number; cost_usd: number; error?: string | null }[];
  error?: string | null;
}

// Run a job by forwarding it to the shared pipeline container instance. A
// single instance key is used (not one per item): the queue consumer runs at
// concurrency 1, so jobs are already serialized, and per-item instances would
// each linger for `sleepAfter` and quickly exceed the container max_instances
// cap ("Maximum number of running containers").
export async function runPipeline(env: Env, job: PipelineJob): Promise<PipelineResult> {
  const instance = getContainer(env.PIPELINE_CONTAINER, "pipeline");
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

// Fetch only metadata (used for fast metadata-first prioritization).
export async function fetchMetadata(
  env: Env,
  source_url: string,
  platform: string,
): Promise<PipelineResult["metadata"]> {
  const instance = getContainer(env.PIPELINE_CONTAINER, `meta-${platform}`);
  const res = await instance.fetch(
    new Request("http://pipeline/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_url, platform }),
    }),
  );
  if (!res.ok) throw new Error(`metadata container ${res.status}`);
  return (await res.json()) as PipelineResult["metadata"];
}
