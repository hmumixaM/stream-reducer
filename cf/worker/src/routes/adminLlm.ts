import { Hono } from "hono";
import type { AppContext } from "../auth";
import type { Env } from "../env";

const PROBE_TIMEOUT_MS = 60_000;

/** Admin diagnostics for the OpenAI-compatible LLM endpoint the pipeline uses. */
export const adminLlmRoutes = new Hono<AppContext>();

async function listModels(env: Env): Promise<{ models: string[] } | { error: string }> {
  const response = await fetch(`${env.LLM_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${env.GEMINI_API_KEY}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) return { error: `${response.status}: ${body.slice(0, 300)}` };
  const parsed = JSON.parse(body) as { data?: { id?: string }[] };
  return { models: (parsed.data ?? []).flatMap((entry) => (entry.id ? [entry.id] : [])) };
}

async function probeModel(env: Env, model: string) {
  const started = Date.now();
  const response = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GEMINI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      max_tokens: 16,
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const body = await response.text();
  const ms = Date.now() - started;
  if (!response.ok) return { model, ok: false, ms, status: response.status, error: body.slice(0, 300) };
  const parsed = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
  const reply = parsed.choices?.[0]?.message?.content ?? "";
  return { model, ok: reply.trim().length > 0, ms, reply: reply.slice(0, 80) };
}

// Which models the configured endpoint serves, and — with ?model= — whether it
// can actually answer with one. Handy when a new Gemini release lands.
adminLlmRoutes.get("/llm-check", async (c) => {
  const listing = await listModels(c.env);
  const model = c.req.query("model");
  return c.json({
    base_url: c.env.LLM_BASE_URL,
    configured: {
      model: c.env.LLM_MODEL,
      fallback: c.env.LLM_MODEL_FALLBACK ?? null,
      infographic: c.env.LLM_MODEL_INFOGRAPHIC,
      stt: c.env.STT_MODEL,
    },
    ...listing,
    probe: model ? await probeModel(c.env, model) : null,
  });
});
