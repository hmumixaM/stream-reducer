import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";

vi.mock("../auth", () => ({
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { adminLlmRoutes } from "./adminLlm";

function fakeEnv() {
  return {
    LLM_BASE_URL: "https://proxy.example/v1",
    LLM_MODEL: "gemini-3.5-flash",
    LLM_MODEL_FALLBACK: "gemini-2.5-flash",
    LLM_MODEL_INFOGRAPHIC: "gemini-3-pro-image-preview",
    STT_MODEL: "openai/whisper-large-v3-turbo",
    GEMINI_API_KEY: "sk-test",
  } as unknown as Env;
}

async function call(path: string) {
  const app = new Hono<AppContext>();
  app.route("/api/admin", adminLlmRoutes);
  return app.request(path, undefined, fakeEnv());
}

afterEach(() => vi.unstubAllGlobals());

describe("llm-check", () => {
  it("reports the models the endpoint serves", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ data: [{ id: "gemini-3.5-flash" }, { id: "gemini-3.7-flash" }] }));
    });

    const body = (await (await call("/api/admin/llm-check")).json()) as {
      models: string[];
      probe: unknown;
      configured: { model: string };
    };

    expect(calls).toEqual(["https://proxy.example/v1/models"]);
    expect(body.models).toContain("gemini-3.7-flash");
    expect(body.configured.model).toBe("gemini-3.5-flash");
    // No ?model=, so nothing is spent on a completion.
    expect(body.probe).toBeNull();
  });

  it("asks a named model to answer", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });

    const body = (await (await call("/api/admin/llm-check?model=gemini-3.7-flash")).json()) as {
      probe: { model: string; ok: boolean; reply: string };
    };

    expect(JSON.parse(bodies[0]).model).toBe("gemini-3.7-flash");
    expect(body.probe.ok).toBe(true);
    expect(body.probe.reply).toBe("ok");
  });

  it("passes an upstream rejection through instead of throwing", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/models")
        ? new Response(JSON.stringify({ data: [] }))
        : new Response("model not found", { status: 400 }),
    );

    const body = (await (await call("/api/admin/llm-check?model=nope")).json()) as {
      probe: { ok: boolean; status: number; error: string };
    };

    expect(body.probe).toMatchObject({ ok: false, status: 400, error: "model not found" });
  });
});
