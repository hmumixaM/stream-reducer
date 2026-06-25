import type { Env } from "../env";
import { first } from "../db";
import { isoNow } from "../lib/crypto";

interface ChunkRow {
  id: number;
  item_id: number;
  field: string;
  text: string;
  embedding: string;
}

interface ChunkVec {
  id: number;
  item_id: number;
  field: string;
  text: string;
  vec: number[];
}

interface GraphEdge {
  source: number;
  target: number;
  weight: number;
}

interface GraphParagraph {
  id: number;
  item_id: number;
  field: string;
  text: string;
  community: number;
  degree: number;
}

interface GraphTopology {
  edges: GraphEdge[];
  degree: number[];
  adjacency: number[][];
}

// Build the GLOBAL knowledge graph: nodes are summary paragraphs, edges link
// paragraphs by cosine similarity (exact kNN), communities by label
// propagation, plus per-item related-article recommendations. The result is
// serialized into graph_cache (read by /api/graph and filtered per user).
export async function buildGraph(env: Env, force: boolean): Promise<void> {
  const cap = Math.min(Number(env.GRAPH_KNN_K || "6"), 12);
  const simThreshold = Number(env.GRAPH_SIM_THRESHOLD || "0.6");
  const MAX_NODES = 4000;

  const chunkRows = await loadSummaryChunkRows(env, MAX_NODES);
  const fingerprint = graphFingerprint(chunkRows);
  if (!force && await cacheIsFresh(env, fingerprint)) return;

  const chunks = chunkRows.map(parseChunkVector);
  const topology = buildGraphTopology(chunks, cap, simThreshold);
  const community = labelPropagation(topology.adjacency);
  const paragraphs = serializeGraphParagraphs(chunks, community, topology.degree);
  const buildId = Date.now();

  await replaceGraphTables(env, buildId, paragraphs, topology.edges);
  await persistItemRecommendations(env, chunks, topology.edges);
  await persistGraphCache(env, buildId, fingerprint, chunks, paragraphs, topology.edges);
}

async function loadSummaryChunkRows(env: Env, maxNodes: number): Promise<ChunkRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, item_id, field, text, embedding FROM chunk
       WHERE source = 'summary' AND embedding IS NOT NULL
       ORDER BY id DESC LIMIT ?`,
  )
    .bind(maxNodes)
    .all<ChunkRow>();

  return rows.results ?? [];
}

function graphFingerprint(chunkRows: ChunkRow[]): string {
  return `${chunkRows.length}:${chunkRows[0]?.id ?? 0}:${chunkRows[chunkRows.length - 1]?.id ?? 0}`;
}

async function cacheIsFresh(env: Env, fingerprint: string): Promise<boolean> {
  const cache = await first<{ fingerprint: string }>(
    env.DB.prepare("SELECT fingerprint FROM graph_cache WHERE id = 1"),
  );

  return cache?.fingerprint === fingerprint;
}

function parseChunkVector(row: ChunkRow): ChunkVec {
  return {
    id: row.id,
    item_id: row.item_id,
    field: row.field,
    text: row.text,
    vec: JSON.parse(row.embedding) as number[],
  };
}

function buildGraphTopology(nodes: ChunkVec[], cap: number, simThreshold: number): GraphTopology {
  const edges = buildExactKnnEdges(nodes, cap, simThreshold);
  const adjacency = buildAdjacency(nodes, edges);
  const degree = nodes.map((node) =>
    edges.filter((edge) => edge.source === node.id || edge.target === node.id).length,
  );

  return { edges, degree, adjacency };
}

function buildExactKnnEdges(nodes: ChunkVec[], cap: number, simThreshold: number): GraphEdge[] {
  return nodes.flatMap((sourceNode, sourceIndex) =>
    nodes
      .map((targetNode, targetIndex) => ({
        targetIndex,
        score: sourceIndex === targetIndex ? -Infinity : dot(sourceNode.vec, targetNode.vec),
      }))
      .filter(({ score }) => score >= simThreshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, cap)
      .filter(({ targetIndex }) => sourceIndex < targetIndex)
      .map(({ targetIndex, score }) => ({
        source: sourceNode.id,
        target: nodes[targetIndex].id,
        weight: score,
      })),
  );
}

function buildAdjacency(nodes: ChunkVec[], edges: GraphEdge[]): number[][] {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  return nodes.map((node) =>
    edges
      .flatMap((edge) => {
        if (edge.source === node.id) return [indexById.get(edge.target)];
        if (edge.target === node.id) return [indexById.get(edge.source)];
        return [];
      })
      .filter((index): index is number => index !== undefined),
  );
}

function serializeGraphParagraphs(
  nodes: ChunkVec[],
  community: number[],
  degree: number[],
): GraphParagraph[] {
  return nodes.map((node, index) => ({
    id: node.id,
    item_id: node.item_id,
    field: node.field,
    text: node.text.slice(0, 600),
    community: community[index],
    degree: degree[index],
  }));
}

async function replaceGraphTables(
  env: Env,
  buildId: number,
  paragraphs: GraphParagraph[],
  edges: GraphEdge[],
): Promise<void> {
  await env.DB.prepare("DELETE FROM graph_paragraph").run();
  await env.DB.prepare("DELETE FROM graph_link").run();
  await env.DB.prepare("DELETE FROM item_recommendation").run();

  for (const paragraph of paragraphs) {
    await env.DB.prepare(
      "INSERT INTO graph_paragraph (build_id, chunk_id, item_id, field, text, community, degree) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(buildId, paragraph.id, paragraph.item_id, paragraph.field, paragraph.text, paragraph.community, paragraph.degree)
      .run();
  }

  for (const edge of edges) {
    await env.DB.prepare("INSERT INTO graph_link (src_chunk_id, dst_chunk_id, weight) VALUES (?, ?, ?)")
      .bind(edge.source, edge.target, edge.weight)
      .run();
  }
}

async function persistItemRecommendations(env: Env, nodes: ChunkVec[], edges: GraphEdge[]): Promise<void> {
  const idToItem = new Map(nodes.map((nd) => [nd.id, nd.item_id]));
  const recScore = new Map<string, number>();

  for (const edge of edges) {
    const a = idToItem.get(edge.source);
    const b = idToItem.get(edge.target);
    if (a === undefined || b === undefined) continue;
    if (a === b) continue;
    bump(recScore, `${a}:${b}`, edge.weight);
    bump(recScore, `${b}:${a}`, edge.weight);
  }

  for (const [key, score] of recScore) {
    const [a, b] = key.split(":").map(Number);
    await env.DB.prepare("INSERT INTO item_recommendation (item_id, related_item_id, score) VALUES (?, ?, ?)")
      .bind(a, b, score)
      .run();
  }
}

async function persistGraphCache(
  env: Env,
  buildId: number,
  fingerprint: string,
  nodes: ChunkVec[],
  paragraphs: GraphParagraph[],
  edges: GraphEdge[],
): Promise<void> {
  const titles = await env.DB.prepare("SELECT id, title, platform FROM item").all<{ id: number; title: string | null; platform: string }>();
  const titleMap = new Map((titles.results ?? []).map((t) => [t.id, t]));
  const blob = JSON.stringify({
    build_id: buildId,
    built_at: isoNow(),
    nodes: paragraphs.map((paragraph) => ({
      ...paragraph,
      title: titleMap.get(paragraph.item_id)?.title ?? null,
      platform: titleMap.get(paragraph.item_id)?.platform ?? "unknown",
    })),
    edges,
  });
  const itemCount = new Set(nodes.map((nd) => nd.item_id)).size;
  await env.DB.prepare(
    `INSERT INTO graph_cache (id, build_id, blob, fingerprint, node_count, item_count, built_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET build_id=excluded.build_id, blob=excluded.blob,
       fingerprint=excluded.fingerprint, node_count=excluded.node_count,
       item_count=excluded.item_count, built_at=excluded.built_at`,
  )
    .bind(buildId, blob, fingerprint, paragraphs.length, itemCount, isoNow())
    .run();
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

function bump<K>(map: Map<K, number>, key: K, val: number): void {
  map.set(key, (map.get(key) ?? 0) + val);
}

// Lightweight community detection (label propagation) as a Louvain stand-in.
function labelPropagation(adj: number[][]): number[] {
  const n = adj.length;
  let labels = Array.from({ length: n }, (_, i) => i);
  for (let iter = 0; iter < 8; iter++) {
    const nextLabels = labels.map((currentLabel, i) => {
      if (!adj[i].length) return currentLabel;
      const counts = new Map<number, number>();
      for (const j of adj[i]) bump(counts, labels[j], 1);
      let best = currentLabel;
      let bestCount = -1;
      for (const [label, count] of counts) {
        if (count > bestCount) {
          bestCount = count;
          best = label;
        }
      }
      return best;
    });
    const changed = nextLabels.some((label, index) => label !== labels[index]);
    labels = nextLabels;
    if (!changed) break;
  }
  // Re-index labels to a dense 0..k range.
  const remap = new Map<number, number>();
  return labels.map((l) => {
    if (!remap.has(l)) remap.set(l, remap.size);
    return remap.get(l)!;
  });
}
