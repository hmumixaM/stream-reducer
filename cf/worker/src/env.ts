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
  GRAPH_KNN_K: string;
  GRAPH_SIM_THRESHOLD: string;

  // Secrets
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  SESSION_SECRET: string;
}

// A unit of pipeline work. `kind` selects the action the queue consumer runs.
export type PipelineMessage =
  | { kind: "process"; item_id: number }
  | { kind: "resummarize"; item_id: number }
  | { kind: "poll"; subscription_id: number }
  | { kind: "graph_build"; force?: boolean };
