import { describe, expect, it } from "vitest";
import { includeSummaryDescription } from "./summaryDescription";

describe("includeSummaryDescription", () => {
  it("adds the original description before the source link", () => {
    const content = includeSummaryDescription(
      "## TL;DR\nA talk.\n\n[Source](https://youtu.be/abc)",
      { tldr: "A talk." },
      "Original abstract.",
      "https://youtu.be/abc",
    );

    expect(content.markdown).toContain(
      "## Video description\nOriginal abstract.\n\n[Source]",
    );
    expect(content.structured.description).toBe("Original abstract.");
  });

  it("does not duplicate an existing description section", () => {
    const markdown = "## Video description\nOriginal abstract.";
    const content = includeSummaryDescription(
      markdown,
      {},
      "Original abstract.",
      "https://youtu.be/abc",
    );

    expect(content.markdown).toBe(markdown);
    expect(content.structured.description).toBe("Original abstract.");
  });
});
