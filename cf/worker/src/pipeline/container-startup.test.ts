import { beforeEach, describe, expect, it, vi } from "vitest";

const { start, proxy, renew } = vi.hoisted(() => ({
  start: vi.fn(), proxy: vi.fn(), renew: vi.fn(),
}));
vi.mock("@cloudflare/containers", () => ({
  Container: class {
    env = {};
    startAndWaitForPorts = start;
    renewActivityTimeout = renew;
    fetch(request: Request) { return proxy(request); }
  },
  getContainer: vi.fn(),
}));
import { PipelineContainer } from "./container";
import type { Env } from "../env";

beforeEach(() => {
  vi.resetAllMocks();
  proxy.mockResolvedValue(new Response("ok"));
});

describe("pipeline cold boot", () => {
  it("keeps the idle alarm beyond port readiness and restores normal stream cleanup", async () => {
    const container = new PipelineContainer({} as DurableObjectState<{}>, {} as Env);
    start.mockImplementation(async (options) => {
      expect(container.sleepAfter).toBe("150s");
      expect(options.cancellationOptions.portReadyTimeoutMS).toBe(120000);
    });
    const request = new Request("http://pipeline/process_stream");
    expect(await (await container.fetch(request)).text()).toBe("ok");
    expect(container.sleepAfter).toBe("30s");
    expect(renew).toHaveBeenCalledOnce();
    expect(proxy).toHaveBeenCalledWith(request);
  });

  it("restores idle cleanup and preserves a classifiable startup error on failure", async () => {
    const container = new PipelineContainer({} as DurableObjectState<{}>, {} as Env);
    start.mockRejectedValue(new Error("The container just exited"));
    await expect(container.fetch(new Request("http://pipeline/process_stream")))
      .rejects.toThrow("Failed to start container: The container just exited");
    expect(container.sleepAfter).toBe("30s");
    expect(renew).toHaveBeenCalledOnce();
    expect(proxy).not.toHaveBeenCalled();
  });
});
