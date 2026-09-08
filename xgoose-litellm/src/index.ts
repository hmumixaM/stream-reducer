import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  LITELLM: DurableObjectNamespace<LiteLLMContainer>;
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  GEMINI_PROXY_BASE: string;
  GEMINI_PROXY_KEY: string;
  LITELLM_MASTER_KEY: string;
  VERTEX_CREDENTIALS: string;
  ANTHROPIC_PROXY_KEY: string;
  RIGHTCODE_API_KEY: string;
}

const USER_BLOCK_CACHE = new Map<string, { disabled: boolean; at: number }>();
const USER_BLOCK_TTL_MS = 5_000;
const USER_DISABLED_BODY = JSON.stringify({
  error: {
    message: "This account has been disabled.",
    type: "user_disabled",
    code: "user_disabled",
  },
});

async function isDisabledUser(env: Env, userField: string): Promise<boolean> {
  if (!userField.startsWith("xgoose:")) return false;
  const id = userField.slice("xgoose:".length).trim();
  if (!id) return false;

  const cached = USER_BLOCK_CACHE.get(id);
  if (cached && Date.now() - cached.at < USER_BLOCK_TTL_MS) {
    return cached.disabled;
  }

  const row = await env.DB.prepare(
    "SELECT disabled_at FROM users WHERE id = ? LIMIT 1",
  )
    .bind(id)
    .first<{ disabled_at: string | null }>();
  const disabled = Boolean(row?.disabled_at);
  USER_BLOCK_CACHE.set(id, { disabled, at: Date.now() });
  return disabled;
}

export class LiteLLMContainer extends Container<Env> {
  defaultPort = 4000;
  sleepAfter = "30m";
  enableInternet = true;

  override envVars = {
    GEMINI_PROXY_BASE: this.env.GEMINI_PROXY_BASE,
    GEMINI_PROXY_KEY: this.env.GEMINI_PROXY_KEY,
    LITELLM_MASTER_KEY: this.env.LITELLM_MASTER_KEY,
    VERTEX_CREDENTIALS: this.env.VERTEX_CREDENTIALS,
    ANTHROPIC_PROXY_KEY: this.env.ANTHROPIC_PROXY_KEY,
    RIGHTCODE_API_KEY: this.env.RIGHTCODE_API_KEY,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/chat/completions")
    ) {
      const body: Record<string, unknown> = await request
        .clone()
        .json<Record<string, unknown>>()
        .catch(() => ({}));
      const userField = typeof body.user === "string" ? body.user : "";
      if (await isDisabledUser(env, userField)) {
        return new Response(USER_DISABLED_BODY, {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const container = getContainer(
      env.LITELLM,
      "litellm-primary",
    );
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
