import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

const { instance, getContainer } = vi.hoisted(() => {
  const instance = { fetch: vi.fn(), destroy: vi.fn() };
  return { instance, getContainer: vi.fn(() => instance) };
});
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getContainer }));

import { runPipeline } from "./container";

const env = { CONTAINER_GEN: "7", PIPELINE_CONTAINER: {} } as unknown as Env;
const job = { item_id: 42, source_url: "https://example.com/v", platform: "youtube", mode: "process" } as Parameters<typeof runPipeline>[1];

describe("runPipeline container release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    instance.destroy.mockResolvedValue(undefined);
  });

  it("destroys the job instance after a successful run", async () => {
    instance.fetch.mockResolvedValue(new Response(JSON.stringify({ stages: [] }), { status: 200 }));

    await runPipeline(env, job);

    expect(getContainer).toHaveBeenLastCalledWith(env.PIPELINE_CONTAINER, "job-42-g7");
    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the instance when the container fails, keeping the original error", async () => {
    instance.fetch.mockResolvedValue(new Response("boom", { status: 500 }));
    instance.destroy.mockRejectedValue(new Error("not running"));

    await expect(runPipeline(env, job)).rejects.toThrow("pipeline container 500: boom");
    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });
});
