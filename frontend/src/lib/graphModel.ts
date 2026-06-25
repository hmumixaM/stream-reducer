import type { GraphData, GraphEdge, GraphFilters, GraphNode } from "@/lib/api";

export interface GraphCanvasNode extends GraphNode {
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

export interface GraphCanvasLink {
  source: number | GraphCanvasNode;
  target: number | GraphCanvasNode;
  weight: number;
}

export interface GraphCanvasData {
  nodes: GraphCanvasNode[];
  links: GraphCanvasLink[];
}

export interface PinnedNodePosition {
  fx: number;
  fy: number;
}

export type PinnedNodePositions = Record<number, PinnedNodePosition>;

export interface GraphQueryState {
  favorite: boolean;
  archived: boolean;
  platform: string;
  folders: number[];
  focus: string | null;
}

export interface NeighborNode {
  node: GraphNode;
  weight: number;
}

export function parseGraphQuery(params: URLSearchParams): GraphQueryState {
  return {
    favorite: params.get("favorite") === "1",
    archived: params.get("archived") === "1",
    platform: params.get("platform") ?? "",
    folders: parseFolderIds(params.get("folders")),
    focus: params.get("focus"),
  };
}

export function graphFilters(queryState: GraphQueryState, mirrorMode: boolean): GraphFilters | undefined {
  if (mirrorMode) return undefined;

  return {
    favorite: queryState.favorite,
    archived: queryState.archived,
    platform: queryState.platform || undefined,
    folders: queryState.folders,
  };
}

export function buildGraphCanvasData(
  graph: GraphData,
  pinnedPositions: PinnedNodePositions,
): GraphCanvasData {
  return {
    nodes: graph.nodes.map((node) => ({
      ...node,
      ...pinnedPositions[node.id],
    })),
    links: graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
    })),
  };
}

export function buildAdjacency(edges: GraphEdge[]): Map<number, Set<number>> {
  const adjacency = new Map<number, Set<number>>();

  for (const edge of edges) {
    const sourceNeighbors = adjacency.get(edge.source) ?? new Set<number>();
    const targetNeighbors = adjacency.get(edge.target) ?? new Set<number>();

    adjacency.set(edge.source, new Set([...sourceNeighbors, edge.target]));
    adjacency.set(edge.target, new Set([...targetNeighbors, edge.source]));
  }

  return adjacency;
}

export function highlightedNodeIds(
  hoverNodeId: number | null,
  adjacency: Map<number, Set<number>>,
): Set<number> | null {
  if (hoverNodeId == null) return null;

  return new Set([hoverNodeId, ...(adjacency.get(hoverNodeId) ?? [])]);
}

export function connectedNeighbors(graph: GraphData, selectedNode: GraphNode): NeighborNode[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const neighborWeights = new Map<number, number>();

  for (const edge of graph.edges) {
    if (edge.source === selectedNode.id) neighborWeights.set(edge.target, edge.weight);
    if (edge.target === selectedNode.id) neighborWeights.set(edge.source, edge.weight);
  }

  return [...neighborWeights.entries()]
    .map(([nodeId, weight]) => ({ node: nodeById.get(nodeId), weight }))
    .filter((entry): entry is NeighborNode => entry.node !== undefined)
    .sort((left, right) => right.weight - left.weight);
}

export function parseFolderIds(value: string | null): number[] {
  return (value ?? "")
    .split(",")
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
}
