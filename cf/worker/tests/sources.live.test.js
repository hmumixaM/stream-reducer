import { describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => ({ fetch: async request => { if (!process.env.SOURCE_DISCOVERY_FALLBACK) throw new Error("Live test has no Cloudflare container binding"); return fetch(new Request(process.env.SOURCE_DISCOVERY_FALLBACK + new URL(request.url).pathname, request)); } }) }));
import { discoverSources } from "../src/lib/sourceDiscovery";
// Opt-in only: normal CI must not depend on external search/risk-control state.
describe.skipIf(process.env.SOURCE_DISCOVERY_LIVE !== "1")("live public source search", () => {
  for (const provider of ["youtube", "bilibili", "apple_podcast", "substack"]) {
    it(`searches ${provider} and returns stable follow identities`, async () => {
      const rows = await discoverSources({}, provider, provider === "substack" ? "technology" : "Lex");
      expect(rows.length).toBeGreaterThan(0);
      if (provider === "substack") expect(rows.every(r => r.access === "free" && r.kind === "article")).toBe(true);
      expect(rows.length).toBeLessThanOrEqual(100);
      expect(rows.every(r => r.provider === provider && r.provider_id && r.aliases.length && r.feed_url)).toBe(true);
    }, 15000);
  }
});
