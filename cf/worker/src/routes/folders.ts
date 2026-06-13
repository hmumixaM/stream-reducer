import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";

export const folderRoutes = new Hono<AppContext>();
folderRoutes.use("*", requireAuth);

interface GroupRow {
  id: number;
  user_id: number;
  platform: string;
  external_id: string | null;
  source_url: string;
  title: string | null;
  item_count: number;
  created_at: string;
}

// List the user's folders, with a live member count.
folderRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  const archived = c.req.query("archived");
  const groups = await all<GroupRow>(
    c.env.DB.prepare("SELECT * FROM itemgroup WHERE user_id = ? ORDER BY created_at DESC").bind(userId),
  );
  const out: GroupRow[] = [];
  for (const g of groups) {
    let countSql = "SELECT COUNT(*) AS n FROM user_item WHERE user_id = ? AND folder_id = ?";
    const binds: unknown[] = [userId, g.id];
    if (archived !== undefined) {
      countSql += " AND is_archived = ?";
      binds.push(archived === "true" ? 1 : 0);
    }
    const row = await first<{ n: number }>(c.env.DB.prepare(countSql).bind(...binds));
    g.item_count = row?.n ?? 0;
    if (archived === undefined || g.item_count > 0) out.push(g);
  }
  return c.json(out);
});

folderRoutes.post("/", async (c) => {
  const userId = c.get("user").id;
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const title = (body.title || "").trim();
  if (!title) return c.json({ error: "empty folder name" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO itemgroup (user_id, platform, source_url, title) VALUES (?, 'unknown', '', ?)",
  ).bind(userId, title).run();
  const group = await first<GroupRow>(
    c.env.DB.prepare("SELECT * FROM itemgroup WHERE id = ?").bind(res.meta.last_row_id),
  );
  return c.json(group);
});

folderRoutes.patch("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const title = (body.title || "").trim();
  if (!title) return c.json({ error: "empty folder name" }, 400);
  await c.env.DB.prepare("UPDATE itemgroup SET title = ? WHERE id = ? AND user_id = ?")
    .bind(title, id, userId).run();
  const group = await first<GroupRow>(
    c.env.DB.prepare("SELECT * FROM itemgroup WHERE id = ? AND user_id = ?").bind(id, userId),
  );
  if (!group) return c.json({ error: "folder not found" }, 404);
  return c.json(group);
});

folderRoutes.delete("/:id", async (c) => {
  const userId = c.get("user").id;
  const id = Number(c.req.param("id"));
  // Detach members, then delete the folder (items themselves are kept).
  await c.env.DB.prepare("UPDATE user_item SET folder_id = NULL WHERE folder_id = ? AND user_id = ?")
    .bind(id, userId).run();
  await c.env.DB.prepare("DELETE FROM itemgroup WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return c.json({ ok: true });
});
