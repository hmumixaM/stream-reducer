import { Hono } from "hono";
import type { Env, PipelineMessage } from "./env";
import type { AppContext } from "./auth";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
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
import { adminRoutes } from "./routes/admin";
import { oauthRoutes } from "./routes/oauth";
import { mcpHandler } from "./routes/mcp";
import { handleMessage } from "./pipeline/consumer";
import { pollDueSubscriptions } from "./pipeline/subscriptions";

export { PipelineContainer } from "./pipeline/container";

const app = new Hono<AppContext>();

app.get("/api/health", (c) => c.json({ status: "ok", llm_model: c.env.LLM_MODEL, stt_model: c.env.STT_MODEL }));

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
app.route("/api/admin", adminRoutes);
app.route("/oauth", oauthRoutes);

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
      // Defense-in-depth GC of expired/orphaned OAuth tokens, grants, clients.
      await oauthProvider.purgeExpiredData(env);
    } else {
      await pollDueSubscriptions(env);
    }
    // Safety pump: kick the self-draining pipeline in case the continuation
    // chain ever stopped (e.g. a Worker eviction). A no-op when nothing claimable.
    await env.PIPELINE.send({ kind: "process", item_id: 0 });
  },
};
