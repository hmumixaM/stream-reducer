import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAdmin } from "../auth";
import { all, first, type ItemRow } from "../db";
import { toItemRead } from "../lib/serialize";

// Admin-only: user management + global processing-queue oversight.
export const adminRoutes = new Hono<AppContext>();
adminRoutes.use("*", requireAdmin);

// --- Users ---------------------------------------------------------------
adminRoutes.get("/users", async (c) => {
  const rows = await all<Record<string, unknown>>(
    c.env.DB.prepare(
      `SELECT u.id, u.email, u.is_admin, u.created_at,
              (SELECT COUNT(*) FROM user_item ui WHERE ui.user_id = u.id) AS library_count,
              (SELECT COUNT(*) FROM user_item ui JOIN item i ON i.id = ui.item_id
                 WHERE ui.user_id = u.id AND i.status != 'done') AS queued_count,
              (SELECT COUNT(*) FROM subscription s WHERE s.user_id = u.id) AS subscription_count
         FROM user u ORDER BY u.created_at`,
    ),
  );
  return c.json(rows.map((r) => ({ ...r, is_admin: !!r.is_admin })));
});

adminRoutes.post("/users/:id/admin", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { is_admin?: boolean };
  const next = body.is_admin ? 1 : 0;
  // Don't allow removing the last admin.
  if (!next) {
    const admins = await first<{ n: number }>(
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM user WHERE is_admin = 1"),
    );
    const target = await first<{ is_admin: number }>(
      c.env.DB.prepare("SELECT is_admin FROM user WHERE id = ?").bind(id),
    );
    if (target?.is_admin && (admins?.n ?? 0) <= 1) {
      return c.json({ error: "cannot remove the last admin" }, 400);
    }
  }
  await c.env.DB.prepare("UPDATE user SET is_admin = ? WHERE id = ?").bind(next, id).run();
  return c.json({ ok: true });
});

adminRoutes.delete("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === c.get("user").id) return c.json({ error: "cannot delete yourself" }, 400);
  // Per-user rows cascade via FKs; remove them explicitly to be safe.
  for (const t of ["user_item", "comment", "highlight", "subscription", "itemgroup", "session", "item_interest"]) {
    await c.env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(id).run().catch(() => {});
  }
  await c.env.DB.prepare("DELETE FROM user WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// --- Global queue --------------------------------------------------------
// Every non-done item, in the order the worker will claim it, with the owners
// who have it in their library.
adminRoutes.get("/queue", async (c) => {
  const rows = await all<ItemRow & { owners: string | null; owner_count: number }>(
    c.env.DB.prepare(
      `SELECT item.*,
              (SELECT GROUP_CONCAT(DISTINCT u.email) FROM user_item ui JOIN user u ON u.id = ui.user_id
                 WHERE ui.item_id = item.id) AS owners,
              (SELECT COUNT(DISTINCT ui.user_id) FROM user_item ui WHERE ui.item_id = item.id) AS owner_count
         FROM item
        WHERE item.status != 'done'
        ORDER BY item.priority_score DESC, item.request_count DESC, item.enqueued_at ASC`,
    ),
  );
  return c.json(
    rows.map((r, i) => ({
      ...toItemRead(r),
      owners: r.owners ? r.owners.split(",") : [],
      owner_count: r.owner_count ?? 0,
      queue_position: i + 1,
    })),
  );
});

// Bump an item to the front of the queue (and re-enqueue if needed).
adminRoutes.post("/queue/:id/bump", async (c) => {
  const id = Number(c.req.param("id"));
  const top = await first<{ m: number }>(
    c.env.DB.prepare("SELECT MAX(priority_score) AS m FROM item WHERE status != 'done'"),
  );
  const score = (top?.m ?? 0) + 1000;
  await c.env.DB.prepare("UPDATE item SET priority_score = ? WHERE id = ?").bind(score, id).run();
  await c.env.PIPELINE.send({ kind: "process", item_id: id });
  return c.json({ ok: true, priority_score: score });
});

// Re-enqueue a stuck/errored item.
adminRoutes.post("/queue/:id/retry", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("UPDATE item SET status = 'queued', error = NULL WHERE id = ?").bind(id).run();
  await c.env.PIPELINE.send({ kind: "process", item_id: id });
  return c.json({ ok: true });
});

// Remove an item from the global catalog entirely (drops it for all users).
adminRoutes.delete("/queue/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM item WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});
