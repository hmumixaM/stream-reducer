import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";
vi.mock("../auth", () => ({
  requireAuth: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: 7, preferred_language: "en" });
    await next();
  },
}));
vi.mock("../lib/autoTranslate", () => ({ enqueueLibraryContentTranslations: vi.fn().mockResolvedValue(2) }));
vi.mock("../lib/bulletin", () => ({ enqueueBulletinTranslations: vi.fn().mockResolvedValue(3) }));
import { enqueueLibraryContentTranslations } from "../lib/autoTranslate";
import { enqueueBulletinTranslations } from "../lib/bulletin";
import { authRoutes } from "./auth";

function setup() {
  const writes: unknown[][] = [];
  const env = { DB: { prepare() {
    let bindings: unknown[] = [];
    return { bind(...values: unknown[]) { bindings = values; return this; },
      async run() { writes.push(bindings); return { meta: { changes: 1 } }; },
      async all() { return { results: [{ id: 9 }] }; } };
  } } } as unknown as Env;
  const app = new Hono<AppContext>();
  app.route("/auth", authRoutes);
  return { app, env, writes };
}

describe("preferred bulletin language", () => {
  it("saves English and requests English bulletin and library editions", async () => {
    const { app, env, writes } = setup();
    const response = await app.request("/auth/preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preferred_language: "en" }) }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preferred_language: "en", enqueued: 3 });
    expect(writes).toEqual([["en", 7]]);
    expect(enqueueBulletinTranslations).toHaveBeenCalledWith(env, [9], "en");
    expect(enqueueLibraryContentTranslations).toHaveBeenCalledWith(env, 7, "en");
    expect(await (await app.request("/auth/preferences", {}, env)).json()).toEqual({ preferred_language: "en" });
  });
  it("rejects unsupported preferences without writing them", async () => {
    const { app, env, writes } = setup();
    const response = await app.request("/auth/preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preferred_language: "xx" }) }, env);
    expect(response.status).toBe(400);
    expect(writes).toEqual([]);
  });
});
