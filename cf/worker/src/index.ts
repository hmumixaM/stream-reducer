import { Hono } from "hono";
import type { Env, PipelineMessage } from "./env";
import type { AppContext } from "./auth";
import { authRoutes } from "./routes/auth";
import { itemsRoutes } from "./routes/items";
import { folderRoutes } from "./routes/folders";
import { annotationRoutes } from "./routes/annotations";
import { subscriptionRoutes } from "./routes/subscriptions";
import { searchRoutes } from "./routes/search";
import { graphRoutes } from "./routes/graph";
import { statsRoutes } from "./routes/stats";
import { queueRoutes } from "./routes/queue";
import { settingsRoutes } from "./routes/settings";
import { handleMessage } from "./pipeline/consumer";
import { pollDueSubscriptions } from "./pipeline/subscriptions";

export { PipelineContainer } from "./pipeline/container";

const app = new Hono<AppContext>();

app.get("/api/health", (c) => c.json({ status: "ok", llm_model: c.env.LLM_MODEL, stt_model: c.env.STT_MODEL }));

// TEMP: diagnose bilibili reachability from the Worker's egress IP.
app.get("/api/_debug/bili", async (c) => {
  const hdr: Record<string, string> = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    referer: "https://www.bilibili.com",
  };
  if (c.env.BILIBILI_COOKIE) hdr["cookie"] = c.env.BILIBILI_COOKIE;
  const out: Record<string, unknown> = { cookie: c.env.BILIBILI_COOKIE ? "set" : "missing" };
  try {
    const s = (await (await fetch("https://api.bilibili.com/x/series/archives?mid=14145636&series_id=4891774&only_normal=true&sort=desc&pn=1&ps=30", { headers: hdr })).json()) as Record<string, any>;
    out.series = { code: s.code, msg: s.message, n: (s.data?.archives ?? []).length };
  } catch (e) { out.series = String(e); }
  try {
    const d = (await (await fetch("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=&host_mid=505301413&timezone_offset=-480&features=itemOpusStyle", { headers: hdr })).json()) as Record<string, any>;
    out.dynamic = { code: d.code, msg: d.message, n: (d.data?.items ?? []).length };
  } catch (e) { out.dynamic = String(e); }
  return c.json(out);
});

app.route("/api/auth", authRoutes);
// Folders live under /api/items/groups; register before the /:id catch-all.
app.route("/api/items/groups", folderRoutes);
// Comments/highlights (/api/items/:id/...) + the /api/annotations feed.
app.route("/api", annotationRoutes);
app.route("/api/items", itemsRoutes);
app.route("/api/subscriptions", subscriptionRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/graph", graphRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/queue", queueRoutes);
app.route("/api/settings", settingsRoutes);

// Unknown API paths -> JSON 404 (don't fall through to the SPA shell).
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.get("/media/*", async (c) => {
  const key = c.req.path.replace(/^\/media\/+/, "");
  const object = key ? await c.env.MEDIA.get(key) : null;
  if (!object) return c.json({ error: "media not found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers });
});
// Anything else: serve the built SPA (assets binding handles SPA fallback).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  // Pipeline queue consumer.
  async queue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleMessage(env, message.body);
        message.ack();
      } catch (err) {
        console.error("pipeline message failed", message.body, err);
        message.retry();
      }
    }
  },

  // Cron: poll subscriptions (every 15m) + nightly graph rebuild (04:00 UTC).
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "0 4 * * *") {
      await env.PIPELINE.send({ kind: "graph_build", force: false });
    } else {
      await pollDueSubscriptions(env);
    }
  },
};
