import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { generateReadingSummary, parseReadingSummary, readCached, readingContext, READING_VERSION, sourceHash, type ReadingRow } from "./readingSummary";

const source = { id: 1, title: "A source", author: "A speaker", source_url: "https://example.com/source", summary_structured: JSON.stringify({ walkthrough: "### [00:01:30] Evidence\nThe speaker projects 12% growth.\n### [00:04:00] Limits\nThe projection depends on demand." }), summary_markdown: "Original detailed content" };
const brief = { lead: "The speaker projects growth subject to demand.", sections: [{ heading: "Growth", body: "The forecast is 12%.", timestamp: 90 }, { heading: "Limitations", body: "It depends on demand.", timestamp: 240 }], conclusion: "" };
function environment(initial: ReadingRow | null = null) {
  let row = initial;
  const writes: string[] = [];
  const env = { LLM_BASE_URL: "https://example.com/v1", LLM_MODEL: "configured-model", GEMINI_API_KEY: "test-key", DB: { prepare(sql: string) {
    let bindings: unknown[] = [];
    return { bind(...values: unknown[]) { bindings = values; return this; }, async first() { return row; }, async run() {
      writes.push(sql);
      if (sql.startsWith("INSERT")) { row = { source_hash: String(bindings[1]), version: READING_VERSION, status: "processing", updated_at: String(bindings[3]), content: "{}" }; }
      else if (sql.includes("status='done'") && row) { row = { ...row, status: "done", content: String(bindings[0]) }; }
      else if (sql.includes("status='error'") && row) row.status = "error";
      return { meta: { changes: 1 } };
    } };
  } } } as unknown as Env;
  return { env, writes, getRow: () => row };
}
afterEach(() => vi.unstubAllGlobals());
describe("reading edition", () => {
  it("samples the end as well as the opening of long programs", () => {
    const text = Array.from({ length: 80 }, (_, i) => `### [${i}:00] Topic ${i}\n${"Evidence. ".repeat(1200)}`).join("\n\n");
    const context = readingContext(text, 12000);
    expect(context.length).toBeLessThanOrEqual(12000);
    expect(context).toContain("Topic 0");
    expect(context).toContain("Topic 79");
  });
  it("rejects a malformed or empty brief instead of caching a false success", () => {
    expect(parseReadingSummary({ lead: "", sections: [] })).toBeNull();
    expect(parseReadingSummary({ ...brief, sections: [{ heading: "Heading", body: "" }] })).toBeNull();
    expect(parseReadingSummary(brief)).toEqual(brief);
  });
  it("invalidates cached editions when source content or prompt version changes", () => {
    const row = { source_hash: "old", version: READING_VERSION, status: "done", content: JSON.stringify(brief), updated_at: new Date().toISOString() };
    expect(readCached(row, "new").status).toBe("missing");
    expect(readCached({ ...row, version: "obsolete" }, "old").status).toBe("missing");
    expect(readCached(row, "old").content).toEqual(brief);
  });
  it("allows retry after a worker dies mid-generation", () => {
    expect(readCached({ source_hash: "hash", version: READING_VERSION, status: "processing", content: "{}", updated_at: new Date(Date.now() - 180000).toISOString() }, "hash").status).toBe("error");
  });
  it("reuses completed editions without an LLM request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { env } = environment({ source_hash: await sourceHash(source), version: READING_VERSION, status: "done", content: JSON.stringify(brief), updated_at: new Date().toISOString() });
    expect((await generateReadingSummary(env, source)).status).toBe("done");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("creates an independent edition, keeps source language, and drops invented timestamps", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...brief, sections: [brief.sections[0], { ...brief.sections[1], timestamp: 99999 }] }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { env, writes, getRow } = environment();
    const result = await generateReadingSummary(env, source);
    expect(result.content?.sections.map((section) => section.timestamp)).toEqual([90, null]);
    const request = JSON.parse(fetch.mock.calls[0][1].body);
    expect(request.model).toBe("configured-model");
    expect(request.messages[0].content).toContain("SAME language");
    expect(writes.every((sql) => !sql.includes("UPDATE summary "))).toBe(true);
    expect(getRow()?.status).toBe("done");
  });
  it("persists an error when the provider fails so the UI can retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    const { env, getRow } = environment();
    await expect(generateReadingSummary(env, source)).rejects.toThrow("503");
    expect(getRow()?.status).toBe("error");
  });
});
