import { describe, expect, it } from "vitest";
import { errorMessage, isTransientCapacity } from "./transient";

describe("isTransientCapacity", () => {
  it("classifies a blockConcurrencyWhile DO reset as transient", () => {
    // Verbatim from production: a cold container blew the DO startup window while
    // a subscription poll was enumerating a channel. This used to mark the whole
    // subscription 'error' with consecutive_failures climbing.
    expect(
      isTransientCapacity(
        "Error: A call to blockConcurrencyWhile() in a Durable Object waited for too long. " +
          "The call was canceled and the Durable Object was reset.",
      ),
    ).toBe(true);
  });

  it("classifies container pool exhaustion as transient", () => {
    expect(
      isTransientCapacity(
        "Error: feed_entries container 503: There is no Container instance available at this time.",
      ),
    ).toBe(true);
    expect(
      isTransientCapacity("Failed to start container: Maximum number of running container instances exceeded."),
    ).toBe(true);
    expect(isTransientCapacity("durable object reset because its code was updated")).toBe(true);
  });

  it("does NOT classify real feed/content failures as transient", () => {
    // These must still mark the subscription broken so the reason stays visible.
    expect(
      isTransientCapacity("Error: Bilibili returned a non-JSON response (HTTP 412) — likely IP risk control"),
    ).toBe(false);
    expect(isTransientCapacity("SyntaxError: Unexpected token '<'")).toBe(false);
    expect(isTransientCapacity("DownloadError: Video unavailable")).toBe(false);
    expect(isTransientCapacity("feed_entries container 500: DownloadError")).toBe(false);
  });
});

describe("errorMessage", () => {
  it("keeps the error name so classification can match on it", () => {
    expect(errorMessage(new Error("boom"))).toBe("Error: boom");
  });

  it("stringifies non-Error throws", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });
});
