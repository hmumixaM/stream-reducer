import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
vi.mock("./bulletinTranslation", () => ({ translateBulletinEdition: vi.fn(async (_env, _id, _lang, onClaim) => onClaim()) }));
import { translateBulletinEdition } from "./bulletinTranslation";
import { processNextBulletin } from "./bulletinScheduler";

it("drains an English bulletin using its stored language rather than Chinese", async () => {
  const send = vi.fn();
  const env = { DB: { prepare() { return { bind() { return this; }, async run() { return {}; }, async first() { return { item_id: 8, lang: "en" }; } }; } }, BULLETIN_JOBS: { send } } as unknown as Env;
  await processNextBulletin(env);
  expect(translateBulletinEdition).toHaveBeenCalledWith(env, 8, "en", expect.any(Function));
  expect(send).toHaveBeenCalledWith({ kind: "bulletin_drain" });
});
