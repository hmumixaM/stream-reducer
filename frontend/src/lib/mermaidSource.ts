// Mermaid treats parentheses inside an unquoted edge label as a node shape,
// which makes the whole diagram fail. Quote only the labels that need it so
// already-valid diagrams stay untouched.
const EDGE_LABEL = /\|([^|\n]*)\|/g;

export function normalizeMermaidSource(source: string): string {
  const renamed = source.replace(/^(\s*)accDescription:/gim, "$1accDescr:");
  return renamed.replace(EDGE_LABEL, (match, label: string) => {
    const trimmed = label.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return match;
    if (!/[()[\]{}<>]/.test(trimmed)) return match;
    return `|"${trimmed.replace(/"/g, "'")}"|`;
  });
}
