import { describe, expect, it } from "vitest";
import { priorityScore } from "./priority";

describe("priorityScore", () => {
  it("raises priority for requests, interests, subscribers, and views", () => {
    const base = priorityScore({});
    expect(priorityScore({ view_count: 1000 })).toBeGreaterThan(base);
    expect(priorityScore({ request_count: 1 })).toBeGreaterThan(base);
    expect(priorityScore({ interest_count: 1 })).toBeGreaterThan(base);
    expect(priorityScore({ subscriber_demand: 1 })).toBeGreaterThan(base);
  });

  it("weights user demand above raw views", () => {
    expect(priorityScore({ request_count: 2, interest_count: 1 })).toBeGreaterThan(
      priorityScore({ view_count: 1_000_000 }),
    );
  });
});
