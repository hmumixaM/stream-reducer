import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Network } from "lucide-react";
import type { GraphData, GraphNode } from "@/lib/api";
import { PlatformBadge } from "@/components/badges";

const FIELD_LABELS: Record<string, string> = {
  tldr: "Overview",
  key_point: "Key point",
  walkthrough: "Walkthrough",
  outline: "Outline",
  quote: "Quote",
  background: "Background",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ");
}

function snippet(node: GraphNode, n = 140): string {
  const t = (node.text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function NodePanel({
  node,
  graph,
  onSelectNode,
}: {
  node: GraphNode | null;
  graph: GraphData;
  onSelectNode: (id: number) => void;
}) {
  const nodeById = useMemo(() => {
    const m = new Map<number, GraphNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph.nodes]);

  const neighbors = useMemo(() => {
    if (!node) return [];
    const weights = new Map<number, number>();
    for (const e of graph.edges) {
      if (e.source === node.id) weights.set(e.target, e.weight);
      else if (e.target === node.id) weights.set(e.source, e.weight);
    }
    return [...weights.entries()]
      .map(([id, w]) => ({ node: nodeById.get(id), weight: w }))
      .filter((x): x is { node: GraphNode; weight: number } => !!x.node)
      .sort((a, b) => b.weight - a.weight);
  }, [node, graph.edges, nodeById]);

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <Network className="mb-3 h-8 w-8 opacity-40" />
        Select a paragraph to read it and see connected paragraphs.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border p-4">
        <div className="mb-2 flex items-center gap-2">
          <PlatformBadge platform={node.platform} />
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">
            {fieldLabel(node.field)}
          </span>
        </div>
        <Link
          to={`/items/${node.item_id}`}
          className="group inline-flex items-start gap-1 text-sm font-semibold leading-snug hover:underline"
        >
          {node.title || "Untitled"}
          <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
        </Link>
        {/* Cap the paragraph so a long one stays scrollable and never hides the
            connected-paragraphs list below. */}
        <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-foreground/90">
          {node.text}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Connected paragraphs ({neighbors.length})
        </h3>
        {neighbors.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No strongly-linked paragraphs.
          </p>
        )}
        <div className="space-y-0.5">
          {neighbors.map(({ node: n, weight }) => (
            <button
              key={n.id}
              onClick={() => onSelectNode(n.id)}
              className="w-full rounded-md p-2 text-left transition-colors hover:bg-accent"
            >
              <div className="mb-0.5 flex items-center gap-2">
                <span className="truncate text-xs font-medium">{n.title || "Untitled"}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                  {weight.toFixed(2)}
                </span>
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{snippet(n)}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
