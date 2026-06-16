import type { PipelineContainer } from "./pipeline/container";

export interface Env {
  // Static assets (built SPA)
  ASSETS: Fetcher;

  // Storage / data
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  MEDIA: R2Bucket;
  AI: Ai;

  // Queue + container
  PIPELINE: Queue<PipelineMessage>;
  PIPELINE_CONTAINER: DurableObjectNamespace<PipelineContainer>;

  // Email (magic link)
  EMAIL: SendEmail;

  // Vars
  APP_ORIGIN: string;
  EMAIL_FROM: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  STT_MODEL: string;
  EMBEDDING_DIM: string;
  SUBSCRIPTION_WINDOW_DAYS: string;
  SUBSCRIPTION_MIN_DURATION_S?: string;
  GRAPH_KNN_K: string;
  GRAPH_SIM_THRESHOLD: string;

  // Secrets
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  // Bilibili web cookies (Netscape values joined as "name=value; …"), used to
  // clear risk-control on the space/season/series feed APIs. Optional.
  BILIBILI_COOKIE?: string;

  // Comma-separated emails auto-granted admin on sign-in.
  ADMIN_EMAILS?: string;
  // Optional shared secret for headless maintenance: a request carrying a
  // matching `x-admin-token` header passes the admin guard without a session
  // (used for one-off repair/backfill scripts). Unset = disabled.
  ADMIN_TOKEN?: string;
}

// A unit of pipeline work. `kind` selects the action the queue consumer runs.
export type PipelineMessage =
  | { kind: "process"; item_id: number }
  | { kind: "resummarize"; item_id: number }
  | { kind: "structured_backfill"; item_id: number }
  | { kind: "translate"; item_id: number; lang: string }
  | { kind: "poll"; subscription_id: number }
  | { kind: "graph_build"; force?: boolean };
