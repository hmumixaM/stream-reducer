import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requireAdmin, type AppContext } from "../auth";
import { readJson } from "../lib/request";
import { followRss, rssCall } from "../lib/rss";
import { CONNECTION_FIELDS, getSubstackConnection, sealSubstackCookie, substackCookie, substackCall, type SubstackConnection } from "../lib/substack";

export const substackRoutes = new Hono<AppContext>();
substackRoutes.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  // All internal RPC failures are sanitized; never expose a raw upstream body.
  return c.json({ error: error instanceof Error && /^(?:Substack|服务端尚未|需要 substack|请提供有效)/.test(error.message) ? error.message : "Substack 暂时不可用，请稍后重试" }, 422);
});
substackRoutes.get("/connections", requireAuth, async c => {
  c.header("Cache-Control", "private, no-store");
  const rows = await c.env.DB.prepare(`SELECT ${CONNECTION_FIELDS} FROM substack_connection ORDER BY created_at,id`).all();
  return c.json(rows.results);
});
substackRoutes.post("/connections", requireAdmin, async c => {
  const body = await readJson<{ label: string; cookie: string; expires_at?: string }>(c);
  if (typeof body.label !== "string" || !body.label.trim() || body.label.length > 100)
    return c.json({ error: "请填写连接名称（最多 100 字）" }, 400);
  const cookie = substackCookie(body.cookie);
  const id = crypto.randomUUID();
  const credentials = await sealSubstackCookie(c.env, id, cookie);
  // Validate before changing a saved connection; profile data is discarded.
  await rssCall(c.env, "/substack/check", { cookie });
  const expiry = body.expires_at && Number.isFinite(Date.parse(body.expires_at)) ? new Date(body.expires_at).toISOString() : null;
  await c.env.DB.prepare("INSERT INTO substack_connection(id,label,credentials,expires_at,last_checked_at) VALUES(?,?,?,?,?)")
    .bind(id, body.label.trim(), credentials, expiry, new Date().toISOString()).run();
  return c.json({ id, label: body.label.trim(), status: "active", enabled: 1, expires_at: expiry }, 201);
});
substackRoutes.patch("/connections/:id", requireAdmin, async c => {
  const id = c.req.param("id")!;
  const row = await c.env.DB.prepare("SELECT * FROM substack_connection WHERE id=?").bind(id).first<SubstackConnection>();
  if (!row) return c.json({ error: "Substack 连接不存在" }, 404);
  const body = await readJson<{ label?: string; enabled?: boolean; cookie?: string; expires_at?: string | null }>(c);
  if (body.label !== undefined && (typeof body.label !== "string" || !body.label.trim() || body.label.length > 100)) return c.json({ error: "连接名称无效" }, 400);
  let credentials = row.credentials;
  if (body.cookie !== undefined) {
    const cookie = substackCookie(body.cookie);
    credentials = await sealSubstackCookie(c.env, id, cookie);
    await rssCall(c.env, "/substack/check", { cookie });
  }
  const expiry = body.expires_at === undefined ? (body.cookie ? null : row.expires_at) : body.expires_at && Number.isFinite(Date.parse(body.expires_at)) ? new Date(body.expires_at).toISOString() : null;
  await c.env.DB.prepare(`UPDATE substack_connection SET label=?,enabled=?,credentials=?,expires_at=?,revision=revision+1,
    status=CASE WHEN ? THEN 'active' ELSE status END,last_error=CASE WHEN ? THEN NULL ELSE last_error END WHERE id=?`)
    .bind(body.label?.trim() || row.label, typeof body.enabled === "boolean" ? Number(body.enabled) : row.enabled,
      credentials, expiry, Number(body.cookie !== undefined), Number(body.cookie !== undefined), id).run();
  if (body.cookie !== undefined || body.enabled === true) {
    await c.env.DB.prepare("UPDATE rss_source SET auth_error=0,next_poll_at='' WHERE substack_connection_id=?").bind(id).run();
    await c.env.DB.prepare(`UPDATE rss_article SET status='queued',body_key=NULL,attempts=0,next_attempt_at=''
      WHERE completeness!='full' AND status IN ('done','missing','error') AND (lease_until IS NULL OR lease_until<?)
      AND EXISTS(SELECT 1 FROM rss_source_article sa JOIN rss_source s ON s.id=sa.source_id WHERE sa.article_id=rss_article.id AND s.substack_connection_id=?)`)
      .bind(new Date().toISOString(), id).run();
    await c.env.RSS_JOBS.send({ kind: "rss_drain" });
  }
  return c.json({ ok: true });
});

export function connectedSource(id: string, source: Record<string, unknown>) {
  if (!/^\d+$/.test(String(source.substack_publication_id)) || !/^[a-z0-9-]+$/.test(String(source.substack_subdomain)))
    throw new Error("Substack 刊物资料不完整");
  return { ...source, identity: `substack:${id}:${source.substack_publication_id}`, provider: "substack", substack_connection_id: id };
}
substackRoutes.get("/connections/:id/subscriptions", requireAuth, async c => {
  const connection = await getSubstackConnection(c.env, c.req.param("id")!);
  const preview = await substackCall<{ sources: Record<string, unknown>[]; skipped: number }>(c.env, connection, "subscriptions");
  const saved = await c.env.DB.prepare(`SELECT s.id,s.identity,EXISTS(SELECT 1 FROM rss_follow f WHERE f.source_id=s.id AND f.user_id=?) following
    FROM rss_source s WHERE s.substack_connection_id=?`).bind(c.get("user").id, connection.id).all<{ id: number; identity: string; following: number }>();
  const byIdentity = new Map(saved.results.map(row => [row.identity, row]));
  const sources = preview.sources.map(item => {
    const source = connectedSource(connection.id, item);
    const row = byIdentity.get(source.identity);
    return { ...source, id: row?.id ?? null, following: !!row?.following };
  });
  c.header("Cache-Control", "private, no-store");
  return c.json({ sources, skipped: preview.skipped });
});
substackRoutes.post("/connections/:id/follow", requireAuth, async c => {
  const connection = await getSubstackConnection(c.env, c.req.param("id")!);
  const body = await readJson<{ url?: string; publication_id?: string; category?: string; execute?: boolean }>(c);
  let resolved: Record<string, unknown>;
  if (body.url) {
    if (typeof body.url !== "string" || body.url.length > 4096) return c.json({ error: "请填写 Substack 刊物链接" }, 400);
    resolved = await substackCall(c.env, connection, "resolve", { url: body.url });
    if (resolved.choices) return c.json(resolved);
  } else {
    const preview = await substackCall<{ sources: Record<string, unknown>[] }>(c.env, connection, "subscriptions");
    const selected = preview.sources.find(s => s.substack_publication_id === body.publication_id);
    if (!selected) return c.json({ error: "Substack 刊物不在目录中，请刷新或通过链接添加" }, 404);
    resolved = selected;
  }
  const id = await followRss(c.env, c.get("user").id, { ...connectedSource(connection.id, resolved), category: (body.category || "").slice(0, 200) });
  await c.env.RSS_JOBS.send({ kind: "rss_poll", source_id: id });
  return c.json({ id }, 201);
});
substackRoutes.post("/connections/:id/import", requireAuth, async c => {
  const connection = await getSubstackConnection(c.env, c.req.param("id")!);
  const preview = await substackCall<{ sources: Record<string, unknown>[]; skipped: number }>(c.env, connection, "subscriptions");
  const ids = [];
  for (const source of preview.sources) ids.push(await followRss(c.env, c.get("user").id, connectedSource(connection.id, source)));
  if (ids.length) await c.env.RSS_JOBS.sendBatch([...new Set(ids)].map(id => ({ body: { kind: "rss_poll" as const, source_id: id } })));
  return c.json({ imported: new Set(ids).size, skipped: preview.skipped });
});
