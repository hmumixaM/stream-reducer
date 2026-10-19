import { publicArticlesRoutes } from "./routes/publicArticles";
import { serveSeo } from "./lib/seo";
import { rssRoutes } from "./routes/rss";
import { substackRoutes } from "./routes/substack";
import { wakeRss, drainRss, pollRss, type RssMessage } from "./lib/rss";
export { RssContainer } from "./lib/rss";
import { Hono } from "hono";
import type { Env, PipelineMessage } from "./env";
import type { AppContext } from "./auth";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { authRoutes } from "./routes/auth";
import { itemsRoutes } from "./routes/items";
import { folderRoutes } from "./routes/folders";
import { annotationRoutes } from "./routes/annotations";
import { subscriptionRoutes } from "./routes/subscriptions";
import { channelRoutes } from "./routes/channels";
import { sourceRoutes } from "./routes/sources";
import { timelineRoutes } from "./routes/timeline";
import { searchRoutes } from "./routes/search";
import { graphRoutes } from "./routes/graph";
import { statsRoutes } from "./routes/stats";
import { queueRoutes } from "./routes/queue";
import { settingsRoutes } from "./routes/settings";
import { adminRoutes } from "./routes/admin";
import { audioDiagnosticRoutes } from "./routes/audioDiagnostic";
import { oauthRoutes } from "./routes/oauth";
import { collectionRoutes } from "./routes/collections";
import { mcpHandler } from "./routes/mcp";
import { generateResearchForAllUsers, researchRoutes } from "./routes/research";
import { bulletinRoutes } from "./routes/bulletin";
import { feedbackRoutes } from "./routes/feedback";
import { wakeBulletinWorkers } from "./lib/bulletin";
import { handleMessage, failStrandedItems } from "./pipeline/consumer";
import { pollDueSubscriptions } from "./pipeline/subscriptions";
import { refreshBilibiliCookie } from "./lib/biliRefresh";

export { PipelineContainer } from "./pipeline/container";

const app = new Hono<AppContext>();

// Public pages load JSON during React rendering. Crawlers may fetch those
// resources, but the API documents themselves should never be search results.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("X-Robots-Tag", "noindex, nofollow");
});

app.get("/api/health", (c) => c.json({ status: "ok", llm_model: c.env.LLM_MODEL, stt_model: c.env.STT_MODEL }));

app.route("/api/auth", authRoutes);
app.route("/api/internal", audioDiagnosticRoutes);
app.route("/api/rss", rssRoutes);
app.route("/api/public/articles", publicArticlesRoutes);
app.route("/api/substack", substackRoutes);
// Folders live under /api/items/groups; register before the /:id catch-all.
app.route("/api/items/groups", folderRoutes);
// Comments/highlights (/api/items/:id/...) + the /api/annotations feed.
app.route("/api", annotationRoutes);
app.route("/api/items", itemsRoutes);
app.route("/api/collections", collectionRoutes);
app.route("/api/research", researchRoutes);
app.route("/api/bulletin", bulletinRoutes);
app.route("/api/feedback", feedbackRoutes);
app.route("/api/subscriptions", subscriptionRoutes);
app.route("/api/channels", channelRoutes);
app.route("/api/sources", sourceRoutes);
app.route("/api/timeline", timelineRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/graph", graphRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/queue", queueRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/admin", adminRoutes);
app.route("/oauth", oauthRoutes);

// Unknown API paths -> JSON 404 (don't fall through to the SPA shell).
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.get("/media/*", async (c) => {
  const key = c.req.path.replace(/^\/media\/+/, "");
  if (key.startsWith("rss/")) return c.json({error:"not found"},404);
  const object = key ? await c.env.MEDIA.get(key) : null;
  if (!object) return c.json({ error: "media not found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers });
});
for (const path of ["/", "/browse", "/articles", "/rss/articles/:id", "/items/:id", "/bulletin/:id", "/robots.txt", "/llms.txt", "/sitemap.xml", "/sitemaps/:file"]) {
  app.get(path, (c) => serveSeo(c.req.raw, c.env));
}
// Anything else: serve the built SPA (assets binding handles SPA fallback).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

const oauthProvider = new OAuthProvider<Env>({
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  // RFC 7591 dynamic client registration. MCP clients (Claude, Cursor,
  // mcp-remote) self-register here, so users don't pre-create credentials.
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: {
    fetch: app.fetch,
  },
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => oauthProvider.fetch(request, env, ctx),

  // Pipeline queue consumer.
  async queue(batch: MessageBatch<PipelineMessage | RssMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if(message.body.kind === "rss_drain") await drainRss(env);
        else if(message.body.kind === "rss_poll") await pollRss(env,message.body.source_id,message.body.backfill);
        else await handleMessage(env, message.body, message.attempts, message.timestamp);
        message.ack();
      } catch (err) {
        console.error("pipeline message failed", message.body, err);
        // Immediate redelivery burned all retries within seconds while the
        // container pool was full; back off so a slot can free up.
        message.retry({ delaySeconds: Math.min(60 * message.attempts, 300) });
      }
    }
  },

  // Cron: poll subscriptions (every 15m) + nightly graph rebuild (04:00 UTC).
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try { await wakeRss(env); } catch(error) { console.error("RSS scheduler failed",error); }
    await wakeBulletinWorkers(env);
    if (controller.cron === "0 4 * * *") {
      await env.PIPELINE.send({ kind: "graph_build", force: false });
      // Defense-in-depth GC of expired/orphaned OAuth tokens, grants, clients.
      await oauthProvider.purgeExpiredData(env);
      // Keep the Bilibili cookie alive (self-gates via cookie/info; only the
      // first daily check actually rolls the cookie when Bilibili asks for it).
      try {
        await refreshBilibiliCookie(env);
      } catch (err) {
        console.error("bilibili cookie refresh failed", err);
      }
    } else {
      // Reap items orphaned in-progress by a killed consumer (e.g. exceededCpu)
      // that can no longer be auto-reclaimed, so they don't hang forever.
      await failStrandedItems(env);
      await pollDueSubscriptions(env);
      try {
        await generateResearchForAllUsers(env);
      } catch (err) {
        console.error("research brief generation failed", err);
      }
    }
    // Safety pump: kick the self-draining pipeline in case the continuation
    // chain ever stopped (e.g. a Worker eviction). A no-op when nothing claimable.
    await env.ITEM_JOBS.send({ kind: "process", item_id: 0 });
  },
};
