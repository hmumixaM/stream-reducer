import { Hono } from "hono";
import { requireAuth, type AppContext } from "../auth";
import {
  followRss,
  rssCall,
  wakeRss,
  now,
  monthsAgo,
  type RssSource,
  type RssArticle,
  type RssBody,
  type RssEdition,
} from "../lib/rss";

export const rssRoutes = new Hono<AppContext>();
rssRoutes.use("*", requireAuth);
rssRoutes.onError((error, c) =>
  c.json({ error: error.message || "RSS 暂时不可用" }, 422),
);
const positiveId = (value: string) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("无效的编号");
  return id;
};
async function ownsArticle(c: Parameters<typeof requireAuth>[0], id: number) {
  return c.env.DB.prepare(
    `SELECT a.* FROM rss_article a WHERE a.id=? AND EXISTS(
    SELECT 1 FROM rss_source_article sa JOIN rss_follow f ON f.source_id=sa.source_id WHERE sa.article_id=a.id AND f.user_id=?)`,
  )
    .bind(id, c.get("user").id)
    .first<RssArticle>();
}
async function ownsSource(c: Parameters<typeof requireAuth>[0], id: number) {
  return c.env.DB.prepare(
    "SELECT source_id FROM rss_follow WHERE source_id=? AND user_id=?",
  )
    .bind(id, c.get("user").id)
    .first();
}
function foloOwner(c: Parameters<typeof requireAuth>[0]) {
  return (
    c.get("user").email.toLowerCase() ===
    (c.env.FOLO_OWNER_EMAIL || "").toLowerCase()
  );
}

rssRoutes.get("/status", async (c) => {
  const control = await c.env.DB.prepare(
    "SELECT paused FROM rss_control WHERE id=1",
  ).first<{ paused: number }>();
  const counts = await c.env.DB.prepare(
    `SELECT a.status,count(DISTINCT a.id) n FROM rss_article a JOIN rss_source_article sa ON sa.article_id=a.id
    JOIN rss_follow f ON f.source_id=sa.source_id WHERE f.user_id=? GROUP BY a.status`,
  )
    .bind(c.get("user").id)
    .all();
  return c.json({
    enabled: c.env.RSS_ENABLED === "true",
    paused: !!control?.paused,
    is_admin: !!c.get("user").is_admin,
    folo_available: foloOwner(c) && !!c.env.FOLO_TOKEN,
    counts: counts.results,
    backfill_since: monthsAgo(),
  });
});
rssRoutes.post("/control", async (c) => {
  if (!c.get("user").is_admin) return c.json({ error: "需要管理员权限" }, 403);
  const body = await c.req.json<{ paused: boolean }>();
  await c.env.DB.prepare("UPDATE rss_control SET paused=? WHERE id=1")
    .bind(Number(!!body.paused))
    .run();
  if (!body.paused) await wakeRss(c.env);
  return c.json({ paused: !!body.paused });
});
rssRoutes.get("/sources", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.*,f.category,(SELECT count(*) FROM rss_source_article sa WHERE sa.source_id=s.id) article_count
    FROM rss_source s JOIN rss_follow f ON f.source_id=s.id WHERE f.user_id=? ORDER BY f.category,s.title`,
  )
    .bind(c.get("user").id)
    .all();
  return c.json(rows.results);
});
rssRoutes.post("/resolve", async (c) => {
  const body = await c.req.json<{ url: string }>();
  if (typeof body.url !== "string" || body.url.length > 4096)
    throw new Error("请粘贴来源或 RSS 链接");
  return c.json(
    await rssCall(c.env, "/resolve", {
      url: body.url,
      token: foloOwner(c) ? c.env.FOLO_TOKEN : "",
    }),
  );
});
rssRoutes.post("/sources", async (c) => {
  const body = await c.req.json<{ url: string; category?: string }>();
  if (typeof body.url !== "string" || body.url.length > 4096)
    throw new Error("请粘贴来源或 RSS 链接");
  const source = await rssCall<Record<string, unknown>>(c.env, "/resolve", {
    url: body.url,
    token: foloOwner(c) ? c.env.FOLO_TOKEN : "",
  });
  if (source.choices) return c.json(source, 409);
  const id = await followRss(c.env, c.get("user").id, {
    ...source,
    category: (body.category ?? "").slice(0, 200),
  });
  await c.env.RSS_JOBS.send({ kind: "rss_poll", source_id: id });
  return c.json({ id }, 201);
});
rssRoutes.patch("/sources/:id", async (c) => {
  const id = positiveId(c.req.param("id"));
  if (!(await ownsSource(c, id))) return c.json({ error: "来源不存在" }, 404);
  const body = await c.req.json<{
    category?: string;
    backfill?: "pause" | "resume" | "retry";
  }>();
  if (typeof body.category === "string")
    await c.env.DB.prepare(
      "UPDATE rss_follow SET category=? WHERE user_id=? AND source_id=?",
    )
      .bind(body.category.slice(0, 200), c.get("user").id, id)
      .run();
  // Backfill is global work for a shared public source. Only admins may pause it.
  if (body.backfill) {
    if (!c.get("user").is_admin)
      return c.json({ error: "历史抓取控制需要管理员权限" }, 403);
    await c.env.DB.prepare(
      "UPDATE rss_source SET backfill_status=?,next_poll_at='' WHERE id=?",
    )
      .bind(body.backfill === "pause" ? "paused" : "running", id)
      .run();
    if (body.backfill !== "pause")
      await c.env.RSS_JOBS.send({
        kind: "rss_poll",
        source_id: id,
        backfill: true,
      });
  }
  return c.json({ ok: true });
});
rssRoutes.delete("/sources/:id", async (c) => {
  await c.env.DB.prepare(
    "DELETE FROM rss_follow WHERE user_id=? AND source_id=?",
  )
    .bind(c.get("user").id, positiveId(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});
rssRoutes.post("/sources/:id/refresh", async (c) => {
  const id = positiveId(c.req.param("id"));
  if (!(await ownsSource(c, id))) return c.json({ error: "来源不存在" }, 404);
  await c.env.RSS_JOBS.send({ kind: "rss_poll", source_id: id });
  return c.json({ queued: true });
});
rssRoutes.post("/import/folo", async (c) => {
  if (!foloOwner(c)) return c.json({ error: "此 Folo 连接属于其他账号" }, 403);
  if (!c.env.FOLO_TOKEN)
    return c.json({ error: "Folo 尚未连接，请使用 OPML 导入" }, 409);
  const body = await c.req.json<{ execute?: boolean }>();
  const preview = await rssCall<{
    sources: Record<string, unknown>[];
    skipped: number;
  }>(c.env, "/subscriptions", { url: "", token: c.env.FOLO_TOKEN });
  if (!body.execute) return c.json(preview);
  const ids = [];
  for (const source of preview.sources)
    ids.push(await followRss(c.env, c.get("user").id, source));
  if (ids.length)
    await c.env.RSS_JOBS.sendBatch(
      [...new Set(ids)].map((id) => ({
        body: { kind: "rss_poll" as const, source_id: id },
      })),
    );
  return c.json({ imported: new Set(ids).size, skipped: preview.skipped });
});
rssRoutes.post("/import/opml", async (c) => {
  const body = await c.req.json<{ text: string; execute?: boolean }>();
  if (typeof body.text !== "string" || body.text.length > 2_000_000)
    throw new Error("OPML 文件超过上限或格式不正确");
  const preview = await rssCall<{
    sources: Record<string, unknown>[];
    skipped: number;
  }>(c.env, "/opml", { text: body.text });
  if (!body.execute) return c.json(preview);
  const ids = [];
  for (const source of preview.sources)
    ids.push(await followRss(c.env, c.get("user").id, source));
  if (ids.length)
    await c.env.RSS_JOBS.sendBatch(
      [...new Set(ids)].map((id) => ({
        body: { kind: "rss_poll" as const, source_id: id },
      })),
    );
  return c.json({ imported: new Set(ids).size, skipped: preview.skipped });
});
rssRoutes.get("/articles", async (c) => {
  const user = c.get("user");
  const args: unknown[] = [user.id];
  const clauses = ["f.user_id=?"];
  if (c.req.query("source")) {
    clauses.push("s.id=?");
    args.push(positiveId(c.req.query("source")!));
  }
  if (c.req.query("category")) {
    clauses.push("f.category=?");
    args.push(c.req.query("category"));
  }
  if (c.req.query("unread") === "true") clauses.push("r.read_at IS NULL");
  if (c.req.query("saved") === "true") clauses.push("r.saved=1");
  if (c.req.query("status")) {
    clauses.push("a.status=?");
    args.push(c.req.query("status"));
  }
  if (c.req.query("after")) {
    clauses.push("a.published_at>=?");
    args.push(c.req.query("after"));
  }
  const page = Math.max(0, Math.min(Number(c.req.query("page")) || 0, 100000));
  const lang = ["zh", "en"].includes(c.req.query("lang") || "")
    ? c.req.query("lang")!
    : "original";
  const rows = await c.env.DB.prepare(
    `SELECT a.id,a.url,a.title,a.author,a.published_at,a.completeness,a.word_count,a.status,a.error,
    a.updated_at,MAX(r.read_at) read_at,MAX(COALESCE(r.saved,0)) saved,GROUP_CONCAT(DISTINCT s.title) source_title,
    (SELECT content FROM rss_edition e WHERE e.article_id=a.id AND e.body_hash=a.body_hash ORDER BY CASE WHEN lang=? THEN 0 WHEN lang='original' THEN 1 ELSE 2 END LIMIT 1) edition
    FROM rss_article a JOIN rss_source_article sa ON sa.article_id=a.id JOIN rss_source s ON s.id=sa.source_id
    JOIN rss_follow f ON f.source_id=s.id LEFT JOIN rss_read r ON r.article_id=a.id AND r.user_id=f.user_id
    WHERE ${clauses.join(" AND ")} GROUP BY a.id ORDER BY COALESCE(a.published_at,a.created_at) DESC,a.id DESC LIMIT 51 OFFSET ?`,
  )
    .bind(lang, ...args, page * 50)
    .all<Record<string, unknown>>();
  return c.json({
    articles: rows.results
      .slice(0, 50)
      .map((r) => ({
        ...r,
        edition: r.edition ? JSON.parse(String(r.edition)) : null,
      })),
    has_more: rows.results.length > 50,
    page,
  });
});
rssRoutes.get("/articles/:id", async (c) => {
  const article = await ownsArticle(c, positiveId(c.req.param("id")));
  if (!article) return c.json({ error: "文章不存在" }, 404);
  const editions = await c.env.DB.prepare(
    "SELECT lang,content,model,tokens FROM rss_edition WHERE article_id=? AND body_hash=?",
  )
    .bind(article.id, article.body_hash)
    .all<{ lang: string; content: string; model: string; tokens: number }>();
  const read = await c.env.DB.prepare(
    "SELECT read_at,saved FROM rss_read WHERE user_id=? AND article_id=?",
  )
    .bind(c.get("user").id, article.id)
    .first();
  const sources = await c.env.DB.prepare(
    `SELECT s.id,s.title,f.category FROM rss_source s JOIN rss_source_article sa ON sa.source_id=s.id
    JOIN rss_follow f ON f.source_id=s.id WHERE sa.article_id=? AND f.user_id=?`,
  )
    .bind(article.id, c.get("user").id)
    .all();
  const { seed_key: _s, body_key: _b, lease_token: _l, ...safe } = article;
  return c.json({
    ...safe,
    read: read ?? { read_at: null, saved: 0 },
    sources: sources.results,
    editions: editions.results.map((e) => ({
      ...e,
      content: JSON.parse(e.content) as RssEdition,
    })),
  });
});
rssRoutes.get("/articles/:id/body", async (c) => {
  const article = await ownsArticle(c, positiveId(c.req.param("id")));
  if (!article) return c.json({ error: "文章不存在" }, 404);
  const body = article.body_key
    ? await c.env.MEDIA.get(article.body_key)
    : null;
  if (!body) return c.json({ error: "正文尚未获取" }, 404);
  c.header("Cache-Control", "private, no-store");
  return c.json(await body.json<RssBody>());
});
rssRoutes.patch("/articles/:id", async (c) => {
  const article = await ownsArticle(c, positiveId(c.req.param("id")));
  if (!article) return c.json({ error: "文章不存在" }, 404);
  const body = await c.req.json<{ read?: boolean; saved?: boolean }>();
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO rss_read(user_id,article_id) VALUES(?,?)",
  )
    .bind(c.get("user").id, article.id)
    .run();
  if (typeof body.read === "boolean")
    await c.env.DB.prepare(
      "UPDATE rss_read SET read_at=? WHERE user_id=? AND article_id=?",
    )
      .bind(body.read ? now() : null, c.get("user").id, article.id)
      .run();
  if (typeof body.saved === "boolean")
    await c.env.DB.prepare(
      "UPDATE rss_read SET saved=? WHERE user_id=? AND article_id=?",
    )
      .bind(Number(body.saved), c.get("user").id, article.id)
      .run();
  return c.json({ ok: true });
});
rssRoutes.post("/articles/:id/retry", async (c) => {
  const article = await ownsArticle(c, positiveId(c.req.param("id")));
  if (!article) return c.json({ error: "文章不存在" }, 404);
  const body = await c.req
    .json<{ refetch?: boolean }>()
    .catch(() => ({ refetch: false }));
  await c.env.DB.prepare(
    `UPDATE rss_article SET status='queued',attempts=0,next_attempt_at='',
    body_key=CASE WHEN ? THEN NULL ELSE body_key END WHERE id=? AND (lease_until IS NULL OR lease_until<?)`,
  )
    .bind(Number(!!body.refetch), article.id, now())
    .run();
  await c.env.RSS_JOBS.send({ kind: "rss_drain" });
  return c.json({ queued: true });
});
