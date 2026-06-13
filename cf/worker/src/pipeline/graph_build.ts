import type { Env } from "../env";
import { first } from "../db";
import { isoNow } from "../lib/crypto";

interface ChunkVec {
  id: number;
  item_id: number;
  field: string;
  text: string;
  vec: number[];
}

// Build the GLOBAL knowledge graph: nodes are summary paragraphs, edges link
// paragraphs by cosine similarity (exact kNN), communities by label
// propagation, plus per-item related-article recommendations. The result is
// serialized into graph_cache (read by /api/graph and filtered per user).
export async function buildGraph(env: Env, force: boolean): Promise<void> {
  const cap = Math.min(Number(env.GRAPH_KNN_K || "6"), 12);
  const simThreshold = Number(env.GRAPH_SIM_THRESHOLD || "0.6");
  const MAX_NODES = 4000;

  const rows = await env.DB.prepare(
    `SELECT id, item_id, field, text, embedding FROM chunk
       WHERE source = 'summary' AND embedding IS NOT NULL
       ORDER BY id DESC LIMIT ?`,
  )
    .bind(MAX_NODES)
    .all<{ id: number; item_id: number; field: string; text: string; embedding: string }>();
  const data = rows.results ?? [];

  // Fingerprint: skip rebuild when nothing changed (unless forced).
  const fingerprint = `${data.length}:${data[0]?.id ?? 0}:${data[data.length - 1]?.id ?? 0}`;
  if (!force) {
    const cache = await first<{ fingerprint: string }>(
      env.DB.prepare("SELECT fingerprint FROM graph_cache WHERE id = 1"),
    );
    if (cache && cache.fingerprint === fingerprint) return;
  }

  const nodes: ChunkVec[] = data.map((r) => ({
    id: r.id,
    item_id: r.item_id,
    field: r.field,
    text: r.text,
    vec: JSON.parse(r.embedding) as number[],
  }));

  const n = nodes.length;
  const degree = new Array(n).fill(0);
  const edges: { source: number; target: number; weight: number }[] = [];
  const adjacency: number[][] = Array.from({ length: n }, () => []);

  // Exact kNN over normalized vectors (dot product == cosine).
  for (let i = 0; i < n; i++) {
    const sims: { j: number; s: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const s = dot(nodes[i].vec, nodes[j].vec);
      if (s >= simThreshold) sims.push({ j, s });
    }
    sims.sort((a, b) => b.s - a.s);
    for (const { j, s } of sims.slice(0, cap)) {
      if (i < j) {
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight: s });
        degree[i]++;
        degree[j]++;
        adjacency[i].push(j);
        adjacency[j].push(i);
      }
    }
  }

  const community = labelPropagation(adjacency);

  // Persist derived tables.
  await env.DB.prepare("DELETE FROM graph_paragraph").run();
  await env.DB.prepare("DELETE FROM graph_link").run();
  await env.DB.prepare("DELETE FROM item_recommendation").run();

  const buildId = Date.now();
  const outNodes = nodes.map((nd, i) => ({
    id: nd.id,
    item_id: nd.item_id,
    field: nd.field,
    text: nd.text.slice(0, 600),
    community: community[i],
    degree: degree[i],
  }));

  // Batched inserts.
  for (const nd of outNodes) {
    await env.DB.prepare(
      "INSERT INTO graph_paragraph (build_id, chunk_id, item_id, field, text, community, degree) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(buildId, nd.id, nd.item_id, nd.field, nd.text, nd.community, nd.degree)
      .run();
  }
  for (const e of edges) {
    await env.DB.prepare("INSERT INTO graph_link (src_chunk_id, dst_chunk_id, weight) VALUES (?, ?, ?)")
      .bind(e.source, e.target, e.weight)
      .run();
  }

  // Per-item recommendations: summed cross-item edge weights.
  const idToItem = new Map(nodes.map((nd) => [nd.id, nd.item_id]));
  const recScore = new Map<string, number>();
  for (const e of edges) {
    const a = idToItem.get(e.source)!;
    const b = idToItem.get(e.target)!;
    if (a === b) continue;
    bump(recScore, `${a}:${b}`, e.weight);
    bump(recScore, `${b}:${a}`, e.weight);
  }
  for (const [key, score] of recScore) {
    const [a, b] = key.split(":").map(Number);
    await env.DB.prepare("INSERT INTO item_recommendation (item_id, related_item_id, score) VALUES (?, ?, ?)")
      .bind(a, b, score)
      .run();
  }

  // Title lookup for the serialized blob.
  const titles = await env.DB.prepare("SELECT id, title, platform FROM item").all<{ id: number; title: string | null; platform: string }>();
  const titleMap = new Map((titles.results ?? []).map((t) => [t.id, t]));
  const blob = JSON.stringify({
    build_id: buildId,
    built_at: isoNow(),
    nodes: outNodes.map((nd) => ({
      ...nd,
      title: titleMap.get(nd.item_id)?.title ?? null,
      platform: titleMap.get(nd.item_id)?.platform ?? "unknown",
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
    .bind(buildId, blob, fingerprint, outNodes.length, itemCount, isoNow())
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
  const labels = Array.from({ length: n }, (_, i) => i);
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (!adj[i].length) continue;
      const counts = new Map<number, number>();
      for (const j of adj[i]) bump(counts, labels[j], 1);
      let best = labels[i];
      let bestCount = -1;
      for (const [label, count] of counts) {
        if (count > bestCount) {
          bestCount = count;
          best = label;
        }
      }
      if (best !== labels[i]) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Re-index labels to a dense 0..k range.
  const remap = new Map<number, number>();
  return labels.map((l) => {
    if (!remap.has(l)) remap.set(l, remap.size);
    return remap.get(l)!;
  });
}
