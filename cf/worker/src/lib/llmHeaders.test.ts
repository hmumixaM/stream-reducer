import { describe, expect, it } from "vitest";
import { llmHeaders } from "./llmHeaders";

describe("Oracle LLM authentication", () => {
  it("includes both independent Access credentials and the LiteLLM bearer", () => {
    expect(llmHeaders({ GEMINI_API_KEY: "origin-key", LLM_ACCESS_CLIENT_ID: "access-id", LLM_ACCESS_CLIENT_SECRET: "access-secret" })).toEqual({
      authorization: "Bearer origin-key", "content-type": "application/json",
      "CF-Access-Client-Id": "access-id", "CF-Access-Client-Secret": "access-secret",
    });
  });
  it("does not send a partial Access credential", () => {
    expect(llmHeaders({ GEMINI_API_KEY: "legacy-key", LLM_ACCESS_CLIENT_ID: "id" })).toEqual({
      authorization: "Bearer legacy-key", "content-type": "application/json",
    });
  });
});
