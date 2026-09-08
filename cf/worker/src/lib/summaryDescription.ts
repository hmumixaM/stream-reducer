export interface SummaryContent {
  markdown: string;
  structured: Record<string, unknown>;
}

/**
 * Make the publisher's original description first-class summary content.
 * This is also used as a read-time compatibility layer for summaries produced
 * by a container instance that predates the description-rendering change.
 */
export function includeSummaryDescription(
  markdown: string,
  structured: Record<string, unknown>,
  description: string | null,
  sourceUrl: string,
): SummaryContent {
  const text = (description ?? "").trim();
  if (!text) return { markdown, structured };

  const nextStructured = { ...structured, description: text };
  if (/^## Video description\s*$/m.test(markdown)) {
    return { markdown, structured: nextStructured };
  }

  const sourceLine = `[Source](${sourceUrl})`;
  const trimmed = markdown.trim();
  const section = `## Video description\n${text}`;
  const nextMarkdown = trimmed.endsWith(sourceLine)
    ? `${trimmed.slice(0, -sourceLine.length).trimEnd()}\n\n${section}\n\n${sourceLine}`
    : `${trimmed}${trimmed ? "\n\n" : ""}${section}`;
  return { markdown: nextMarkdown, structured: nextStructured };
}
