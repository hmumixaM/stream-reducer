import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";

// Minimal settings surface. Model selection is configured via Worker vars /
// secrets (not editable at runtime in the multi-user deployment), so this is
// effectively read-only; PUT echoes the effective config back.
export const settingsRoutes = new Hono<AppContext>();
settingsRoutes.use("*", requireAuth);

function effective(c: Parameters<typeof requireAuth>[0]) {
  const env = c.env;
  return {
    llm_base_url: env.LLM_BASE_URL,
    llm_model: env.LLM_MODEL,
    stt_model: env.STT_MODEL,
    summary_map_model: env.LLM_MODEL,
    llm_model_default: env.LLM_MODEL,
    stt_model_default: env.STT_MODEL,
    summary_map_model_default: env.LLM_MODEL,
    llm_model_options: ["gemini-3.5-flash", "gemini-2.5-flash"],
    stt_model_options: ["openai/whisper-large-v3-turbo", "google/chirp-3", "openai/gpt-4o-transcribe"],
    transcribe_chunk_seconds: 300,
    transcribe_rate_limit: 20,
    default_language: "",
    enable_gemini_audio_fallback: false,
    has_openrouter_key: !!env.OPENROUTER_API_KEY,
    has_llm_key: !!env.GEMINI_API_KEY,
  };
}

settingsRoutes.get("/", (c) => c.json(effective(c)));
settingsRoutes.put("/", (c) => c.json(effective(c)));
