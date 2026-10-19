import { Hono } from "hono";
import { getContainer } from "@cloudflare/containers";
import type { AppContext } from "../auth";
import { containerKey, releaseContainer } from "../pipeline/container";

// A fixed public-audio smoke test, isolated from user items, D1 and libraries.
// The audio-service key authorizes this diagnostic only, never admin routes.
export const audioDiagnosticRoutes = new Hono<AppContext>();
audioDiagnosticRoutes.post("/audio-check", async (c) => {
  const expected = c.env.AUDIO_OFFLOAD_TOKEN;
  const supplied = c.req.header("x-audio-token") ?? "";
  if (!expected || supplied.length > 256) return c.json({error:"unauthorized"}, 401);
  const encode = new TextEncoder();
  const [a, b] = await Promise.all([expected, supplied].map(async (value) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encode.encode(value)))));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) return c.json({error:"unauthorized"}, 401);
  const base = "audio-check";
  try {
    const instance = getContainer(c.env.PIPELINE_CONTAINER, containerKey(c.env, base));
    const response = await instance.fetch(new Request("http://pipeline/audio-check", {method:"POST"}));
    const body = await response.text();
    return new Response(body, {status:response.status, headers:{"content-type":"application/json", "cache-control":"no-store"}});
  } finally {
    await releaseContainer(c.env, base);
  }
});
