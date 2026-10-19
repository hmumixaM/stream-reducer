import type { Env } from "../env";

/** Access authenticates the caller before the Oracle LiteLLM sees a request. */
export function llmHeaders(env: Pick<Env, "GEMINI_API_KEY" | "LLM_ACCESS_CLIENT_ID" | "LLM_ACCESS_CLIENT_SECRET">): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.GEMINI_API_KEY}`,
    "content-type": "application/json",
  };
  if (env.LLM_ACCESS_CLIENT_ID && env.LLM_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.LLM_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.LLM_ACCESS_CLIENT_SECRET;
  }
  return headers;
}
