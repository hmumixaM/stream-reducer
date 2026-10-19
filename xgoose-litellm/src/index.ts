import { Container } from "@cloudflare/containers";
import { validGatewayAuth } from "./auth";

interface Env {
  LITELLM: DurableObjectNamespace<LiteLLMContainer>;
  DB: D1Database;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  GEMINI_PROXY_BASE: string;
  GEMINI_PROXY_KEY: string;
  LITELLM_MASTER_KEY: string;
  ORACLE_LITELLM_API_KEY: string;
  ORACLE_ACCESS_CLIENT_ID: string;
  ORACLE_ACCESS_CLIENT_SECRET: string;
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
  // Stream Reducer uses Oracle; other clients retain this on-demand gateway.
  sleepAfter = "5m";
  enableInternet = true;

  override envVars: Record<string, string> = {
    HOME: "/tmp",
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    LITELLM_TELEMETRY: "False",
    EXPERIMENTAL_UI_LOGIN: "false",
    GEMINI_PROXY_BASE: this.env.GEMINI_PROXY_BASE,
    GEMINI_PROXY_KEY: this.env.GEMINI_PROXY_KEY,
    LITELLM_MASTER_KEY: this.env.LITELLM_MASTER_KEY,
    ORACLE_LITELLM_API_KEY: this.env.ORACLE_LITELLM_API_KEY,
    ORACLE_ACCESS_CLIENT_ID: this.env.ORACLE_ACCESS_CLIENT_ID,
    ORACLE_ACCESS_CLIENT_SECRET: this.env.ORACLE_ACCESS_CLIENT_SECRET,
    ANTHROPIC_PROXY_KEY: this.env.ANTHROPIC_PROXY_KEY,
    RIGHTCODE_API_KEY: this.env.RIGHTCODE_API_KEY,
  };

  override async fetch(request: Request): Promise<Response> {
    // The old SDK's default startup window can reject a healthy cold boot.
    const waitUntilReady = () => this.startAndWaitForPorts(4000, {
      instanceGetTimeoutMS: 120_000,
      portReadyTimeoutMS: 120_000,
      abort: request.signal,
    });
    try {
      await waitUntilReady();
    } catch (error) {
      if (request.signal.aborted) throw error;
      // The platform can reject its first readiness probe while a cold VM is
      // still booting. No user request has been forwarded at this point, so a
      // second readiness check cannot duplicate a paid model completion.
      console.warn("Retrying container readiness after a cold-start failure");
      await waitUntilReady();
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Authenticate before starting a billable container or querying user state.
    if (!(await validGatewayAuth(request.headers, env.LITELLM_MASTER_KEY))) {
      return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
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

    // Use the namespace API directly; retain one on-demand gateway instance.
    const container = env.LITELLM.getByName("litellm-primary-1-103-5-sdk011");
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
