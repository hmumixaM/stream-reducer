import { Hono } from "hono";
import { getContainer } from "@cloudflare/containers";
import { containerKey } from "../pipeline/container";
import type { AppContext } from "../auth";
import { requireAdmin } from "../auth";
import { all, first, type ItemRow } from "../db";
import { toItemRead } from "../lib/serialize";
import { cacheThumbnail } from "../lib/ingest";
import { refreshBilibiliCookie } from "../lib/biliRefresh";
import { loadBiliAuth } from "../lib/biliAuth";
import { readJson } from "../lib/request";

// Admin-only: user management + global processing-queue oversight.
export const adminRoutes = new Hono<AppContext>();
adminRoutes.use("*", requireAdmin);

interface AdminUserRow {
  id: number;
  email: string;
  is_admin: number;
  created_at: string;
  library_count: number;
  queued_count: number;
  subscription_count: number;
}

// Manually run the Bilibili cookie refresh (cron runs it daily). `?force=true`
// skips the cookie/info "needs refresh" gate. Reports the outcome + KV state so
// you can confirm the cookie rolled.
adminRoutes.post("/bili-refresh", async (c) => {
  const force = c.req.query("force") === "true";
  const before = await loadBiliAuth(c.env);
  let outcome: { refreshed: boolean; reason: string };
  try {
    outcome = await refreshBilibiliCookie(c.env, { force });
  } catch (err) {
    outcome = { refreshed: false, reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
  const after = await loadBiliAuth(c.env);
  return c.json({
    outcome,
    before: { updated_at: before?.updated_at ?? null, token_len: before?.refresh_token.length ?? 0 },
    after: { updated_at: after?.updated_at ?? null, token_len: after?.refresh_token.length ?? 0 },
    token_changed: !!before && !!after && before.refresh_token !== after.refresh_token,
  });
});

// Diagnostic: report the container's egress IP through each configured WARP
// proxy (and direct), plus Bilibili's risk-control verdict.
adminRoutes.get("/proxy-check", async (c) => {
  const instance = getContainer(c.env.PIPELINE_CONTAINER, containerKey(c.env, "proxy-check"));
  const res = await instance.fetch(new Request("http://pipeline/proxy-check"));
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});

// --- Users ---------------------------------------------------------------
adminRoutes.get("/users", async (c) => {
  const rows = await all<AdminUserRow>(
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
  const body = await readJson<{ is_admin?: boolean }>(c);
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
  for (const table of ["user_item", "comment", "highlight", "subscription", "itemgroup", "session", "item_interest"]) {
    try {
      await c.env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(id).run();
    } catch {
      // Some tables may be absent in older deployments; deleting the user remains authoritative.
    }
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
        WHERE item.status NOT IN ('done', 'excluded')
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

// --- Maintenance ---------------------------------------------------------
// Re-summarize every item whose summary lost its reduce framing (only the
// detailed walkthrough survived because the reduce JSON failed to parse).
// `?dry_run=true` reports the affected items without enqueueing.
adminRoutes.post("/repair-summaries", async (c) => {
  const dryRun = c.req.query("dry_run") === "true";
  const rows = await all<{ item_id: number }>(
    c.env.DB.prepare(
      `SELECT item_id FROM summary
        WHERE COALESCE(json_extract(structured, '$.walkthrough'), '') != ''
          AND COALESCE(json_extract(structured, '$.tldr'), '') = ''
          AND COALESCE(json_extract(structured, '$.background'), '') = ''
          AND COALESCE(json_array_length(json_extract(structured, '$.key_points')), 0) = 0`,
    ),
  );
  const itemIds = rows.map((r) => r.item_id);
  if (!dryRun) {
    for (const id of itemIds) {
      await c.env.DB.prepare("UPDATE item SET status = 'summarizing', error = NULL WHERE id = ?").bind(id).run();
      await c.env.PIPELINE.send({ kind: "resummarize", item_id: id });
    }
  }
  return c.json({ affected: itemIds.length, enqueued: dryRun ? 0 : itemIds.length, item_ids: itemIds });
});

// Regenerate prompt-versioned structured fields (including generated headline /
// subhead) from the stored walkthrough/summary JSON, without re-downloading or
// transcribing media. `?dry_run=true` reports the affected items.
adminRoutes.post("/backfill-structured", async (c) => {
  const dryRun = c.req.query("dry_run") === "true";
  const rows = await all<{ item_id: number }>(
    c.env.DB.prepare(
      `SELECT s.item_id
         FROM summary s
         JOIN item i ON i.id = s.item_id
        WHERE COALESCE(i.headline, '') = ''
           OR COALESCE(i.subhead, '') = ''
           OR COALESCE(json_extract(s.structured, '$.headline'), '') = ''
           OR COALESCE(json_extract(s.structured, '$.subhead'), '') = ''`,
    ),
  );
  const itemIds = rows.map((r) => r.item_id);
  if (!dryRun) {
    for (const id of itemIds) {
      await c.env.PIPELINE.send({ kind: "structured_backfill", item_id: id });
    }
  }
  return c.json({ affected: itemIds.length, enqueued: dryRun ? 0 : itemIds.length, item_ids: itemIds });
});

// Re-generate ONLY the headline/subhead for every summarized item, from the
// stored walkthrough/summary JSON (one cheap LLM call each, no re-download).
// Use after changing the headline prompt. `?dry_run=true` reports the count.
adminRoutes.post("/backfill-headlines", async (c) => {
  const dryRun = c.req.query("dry_run") === "true";
  const rows = await all<{ item_id: number }>(
    c.env.DB.prepare("SELECT item_id FROM summary ORDER BY item_id"),
  );
  const itemIds = rows.map((r) => r.item_id);
  if (!dryRun) {
    for (const id of itemIds) {
      await c.env.PIPELINE.send({ kind: "headline_backfill", item_id: id });
    }
  }
  return c.json({ affected: itemIds.length, enqueued: dryRun ? 0 : itemIds.length });
});

// Backfill on-demand infographics for summarized items that don't have one yet.
// Paid (~$0.13/image), so it's admin-only and supports a dry run + a batch cap:
//   ?dry_run=true     -> report how many would be enqueued, spend nothing
//   ?limit=N          -> only enqueue the first N (test batch before going wide)
//   ?order=views      -> prioritize by view count desc (default: newest item first)
adminRoutes.post("/backfill-infographics", async (c) => {
  const dryRun = c.req.query("dry_run") === "true";
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : null;
  // SQLite sorts NULL as smallest, so DESC naturally puts un-counted items last.
  const orderBy = c.req.query("order") === "views" ? "i.view_count DESC" : "s.item_id DESC";

  const rows = await all<{ item_id: number }>(
    c.env.DB.prepare(
      `SELECT s.item_id
         FROM summary s
         JOIN item i ON i.id = s.item_id
         LEFT JOIN item_infographic ig ON ig.item_id = s.item_id
        WHERE ig.item_id IS NULL OR ig.status = 'error'
        ORDER BY ${orderBy}
        ${limit ? "LIMIT ?" : ""}`,
    ).bind(...(limit ? [limit] : [])),
  );
  const itemIds = rows.map((r) => r.item_id);
  if (!dryRun) {
    for (const id of itemIds) {
      await c.env.DB.prepare(
        `INSERT INTO item_infographic (item_id, status) VALUES (?, 'queued')
         ON CONFLICT(item_id) DO UPDATE SET status='queued', error=NULL, updated_at=excluded.updated_at`,
      ).bind(id).run();
      await c.env.PIPELINE.send({ kind: "infographic", item_id: id });
    }
  }
  return c.json({ candidates: itemIds.length, enqueued: dryRun ? 0 : itemIds.length });
});

// Backfill: mirror existing items' remote cover images into R2 and rewrite the
// thumbnail to the served /media path. Needed for items stored before R2 cover
// caching (notably Bilibili, whose hdslb.com URLs the browser can't load).
//   ?dry_run=true     -> report how many would be cached, fetch nothing
//   ?platform=bilibili -> only that platform (default: all remote thumbnails)
//   ?limit=N          -> cap the batch (default 100; safe under subrequest caps)
adminRoutes.post("/cache-thumbnails", async (c) => {
  const dryRun = c.req.query("dry_run") === "true";
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 100;
  const platform = c.req.query("platform");
  const rows = await all<{ id: number; thumbnail: string }>(
    c.env.DB.prepare(
      `SELECT id, thumbnail FROM item
        WHERE thumbnail LIKE 'http%' ${platform ? "AND platform = ?" : ""}
        ORDER BY id DESC LIMIT ?`,
    ).bind(...(platform ? [platform, limit] : [limit])),
  );
  let cached = 0;
  if (!dryRun) {
    for (const r of rows) {
      const path = await cacheThumbnail(c.env, r.id, r.thumbnail);
      if (path) {
        await c.env.DB.prepare("UPDATE item SET thumbnail = ? WHERE id = ?").bind(path, r.id).run();
        cached++;
      }
    }
  }
  return c.json({ candidates: rows.length, cached: dryRun ? 0 : cached });
});

// Remove an item from the global catalog entirely (drops it for all users).
adminRoutes.delete("/queue/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM item WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});
