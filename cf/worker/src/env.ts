import type { PipelineContainer } from "./pipeline/container";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  // Static assets (built SPA)
  ASSETS: Fetcher;

  // Storage / data
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  MEDIA: R2Bucket;
  AI: Ai;
  OAUTH_KV: KVNamespace;
  // Persisted Bilibili auth: the current cookie + its refresh_token, rolled by
  // the cron-driven refresh (see lib/biliRefresh.ts).
  BILI_AUTH: KVNamespace;

  // OAuth API, injected by the @cloudflare/workers-oauth-provider wrapper into
  // the default/api handlers (used by the /oauth consent routes).
  OAUTH_PROVIDER: OAuthHelpers;

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
  // Image model for on-demand infographics (Gemini 3 Pro Image / Nano Banana Pro).
  LLM_MODEL_INFOGRAPHIC: string;
  STT_MODEL: string;
  EMBEDDING_DIM: string;
  SUBSCRIPTION_WINDOW_DAYS: string;
  SUBSCRIPTION_MIN_DURATION_S?: string;
  GRAPH_KNN_K: string;
  GRAPH_SIM_THRESHOLD: string;
  // Number of WARP SOCKS5 proxies the pipeline container brings up for yt-dlp
  // egress rotation (defaults to "2" in the container if unset).
  WARP_INSTANCES?: string;
  // Optional single proxy (http(s)://… / socks5://…) for yt-dlp egress; only
  // used when PROXY_URLS (WARP rotation) is not set.
  YT_DLP_PROXY?: string;
  // Container instance-key generation. Bump (in wrangler.jsonc vars) to force
  // every job onto a brand-new container instance running the freshly built
  // image (otherwise long-lived instances keep a stale image after a deploy).
  CONTAINER_GEN?: string;
  // Worker-side idle watchdog (ms): abort a streaming pipeline run if the
  // container emits no progress for this long (a genuine stall). Default 240000.
  PIPELINE_IDLE_MS?: string;

  // Secrets
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  // Google AI Studio key for image generation (native generateContent). The
  // text proxy can't emit images, so infographics talk to AI Studio directly.
  // Falls back to GEMINI_API_KEY in the container when unset.
  GEMINI_IMAGE_API_KEY?: string;
  // Bilibili web cookies (Netscape values joined as "name=value; …"), used to
  // clear risk-control on the space/season/series feed APIs. Optional. This is
  // only the initial seed/fallback — the live cookie is kept in the BILI_AUTH KV
  // and auto-refreshed.
  BILIBILI_COOKIE?: string;
  // Bilibili persistent refresh token (browser localStorage `ac_time_value`),
  // required to seed the cookie auto-refresh. Optional.
  BILIBILI_REFRESH_TOKEN?: string;

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
  | { kind: "headline_backfill"; item_id: number }
  | { kind: "infographic"; item_id: number }
  | { kind: "translate"; item_id: number; lang: string }
  | { kind: "poll"; subscription_id: number }
  | { kind: "graph_build"; force?: boolean };
