import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

const { releaseContainer } = vi.hoisted(() => ({ releaseContainer: vi.fn() }));
vi.mock("./container", () => ({
  releaseContainer,
  releaseContainerKey: vi.fn(),
  runPipeline: vi.fn(),
  runPipelineStreaming: vi.fn(),
}));

import { reapSilentItems } from "./consumer";

describe("reapSilentItems", () => {
  it("returns silent in-progress items to the retry state and frees their containers", async () => {
    const queries: { sql: string; bindings: unknown[] }[] = [];
    const DB = {
      prepare(sql: string) {
        const query = { sql, bindings: [] as unknown[] };
        queries.push(query);
        const statement = {
          bind(...bindings: unknown[]) { query.bindings = bindings; return statement; },
          async all() { return { results: [{ id: 11 }, { id: 12 }] }; },
        };
        return statement;
      },
    };

    const before = Date.now();
    await reapSilentItems({ DB } as unknown as Env);

    const [{ sql, bindings }] = queries;
    expect(sql).toContain("started_at = NULL, retry_count = retry_count + 1");
    expect(sql).toContain("COALESCE(progress_updated_at, started_at) < ?");
    expect(bindings.slice(0, 3)).toEqual(["fetching", "transcribing", "summarizing"]);
    const cutoff = Date.parse(bindings[3] as string);
    expect(before - cutoff).toBeGreaterThanOrEqual(20 * 60 * 1000 - 1000);
    expect(releaseContainer.mock.calls).toEqual([
      [expect.anything(), "job-11"],
      [expect.anything(), "job-12"],
    ]);
  });
});
