import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";

export const graphRoutes = new Hono<AppContext>();
graphRoutes.use("*", requireAuth);

interface GraphNode {
  id: number;
  item_id: number;
  title?: string | null;
  platform: string;
  field: string;
  text: string;
  community: number;
  degree: number;
}
interface GraphEdge {
  source: number;
  target: number;
  weight: number;
}
interface GraphBlob {
  build_id: number;
  built_at: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Resolve the set of item_ids the user's filters allow (their personal graph
// is a projection of the global graph over their saved + filtered library).
async function allowedItemIds(
  c: Parameters<typeof requireAuth>[0],
): Promise<Set<number>> {
  const userId = c.get("user").id;
  const u = c.req.query();
  const where = ["ui.user_id = ?"];
  const binds: unknown[] = [userId];
  if (u.favorite === "true") where.push("ui.is_favorite = 1");
  if (u.archived === "true") where.push("ui.is_archived = 1");
  else where.push("ui.is_archived = 0");
  if (u.folders) {
    const ids = u.folders.split(",").map((x) => Number(x)).filter(Boolean);
    if (ids.length) {
      where.push(`ui.folder_id IN (${ids.map(() => "?").join(",")})`);
      binds.push(...ids);
    }
  }
  let sql = `SELECT ui.item_id FROM user_item ui`;
  if (u.platform) sql += ` JOIN item i ON i.id = ui.item_id`;
  sql += ` WHERE ${where.join(" AND ")}`;
  if (u.platform) {
    sql += ` AND i.platform = ?`;
    binds.push(u.platform);
  }
  const rows = await all<{ item_id: number }>(c.env.DB.prepare(sql).bind(...binds));
  return new Set(rows.map((r) => r.item_id));
}

async function loadGlobalGraph(c: Parameters<typeof requireAuth>[0]): Promise<GraphBlob> {
  const row = await first<{ blob: string; build_id: number; built_at: string }>(
    c.env.DB.prepare("SELECT blob, build_id, built_at FROM graph_cache WHERE id = 1"),
  );
  if (!row || !row.blob) return { build_id: 0, built_at: null, nodes: [], edges: [] };
  return JSON.parse(row.blob) as GraphBlob;
}

graphRoutes.get("/", async (c) => {
  const graph = await loadGlobalGraph(c);
  const allowed = await allowedItemIds(c);
  const nodes = graph.nodes.filter((n) => allowed.has(n.item_id));
  const keep = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  return c.json({ build_id: graph.build_id, built_at: graph.built_at, nodes, edges });
});

graphRoutes.get("/items/:id/focus", async (c) => {
  const id = Number(c.req.param("id"));
  const graph = await loadGlobalGraph(c);
  const node = graph.nodes.find((n) => n.item_id === id);
  return c.json({ node_id: node ? node.id : null });
});

graphRoutes.post("/rebuild", async (c) => {
  await c.env.PIPELINE.send({ kind: "graph_build", force: true });
  return c.json({ ok: true, job_id: "queued" });
});
