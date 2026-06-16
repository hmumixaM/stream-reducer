import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { all, first, type ItemRow, type UserItemRow } from "../db";
import { toItemRead } from "../lib/serialize";
import { addUrlToLibrary } from "../lib/ingest";
import { splitUrls } from "../lib/url";
import { embedTexts } from "../lib/embed";
import { getMcpAuthContext } from "agents/mcp";

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const server = new McpServer({ name: "stream-reduce", version: "1.0.0" });

    // The user context comes from the OAuth token exchange
    // We expect the OAuth token exchange callback or external resolver to provide the user ID in `props.userId`
    // Wait, the OAuth provider gives us `props` in `ctx.props`.
    // The `getMcpAuthContext` from `agents/mcp` helps access the request properties if needed.
    // However, with `@cloudflare/workers-oauth-provider`, `apiHandler` gets `ctx.props` populated.
    
    // @ts-ignore
    const props = ctx.props as { userId?: number } | undefined;
    const userId = props?.userId ?? -1;

    function _brief(item: any) {
      return {
        id: item.id,
        title: item.title || item.source_url,
        status: item.status,
        platform: item.platform,
        source_url: item.source_url,
        author: item.author,
        duration_s: item.duration_s,
        published_at: item.published_at,
      };
    }

    server.tool(
      "add_content",
      { urls: z.array(z.string()) },
      async ({ urls }) => {
        if (userId === -1) throw new Error("Unauthorized: missing user ID in token");
        const out: any[] = [];
        const seen = new Set<number>();

        const expandedUrls = urls.flatMap((entry) => splitUrls(entry));
        for (const url of expandedUrls) {
          const res = await addUrlToLibrary(env, userId, url, { folderId: null });
          if (res && !seen.has(res.item.id)) {
            seen.add(res.item.id);
            out.push(_brief(res.item));
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
    );

    server.tool(
      "list_items",
      {
        query: z.string().optional(),
        status: z.string().optional(),
        platform: z.string().optional(),
        limit: z.number().default(20),
      },
      async ({ query, status, platform, limit }) => {
        const where: string[] = ["ui.user_id = ?"];
        const binds: unknown[] = [userId];
        if (status) {
          where.push("item.status = ?");
          binds.push(status);
        }
        if (platform) {
          where.push("item.platform = ?");
          binds.push(platform);
        }
        if (query) {
          where.push("item.title LIKE ?");
          binds.push(`%${query}%`);
        }
        const safeLimit = Math.min(Math.max(limit, 1), 100);

        const rows = await all<any>(
          env.DB.prepare(
            `SELECT item.*
               FROM user_item ui
               JOIN item ON item.id = ui.item_id
               WHERE ${where.join(" AND ")}
               ORDER BY ui.added_at DESC
               LIMIT ?`
          ).bind(...binds, safeLimit)
        );

        return { content: [{ type: "text", text: JSON.stringify(rows.map(_brief), null, 2) }] };
      }
    );

    server.tool(
      "search_content",
      {
        query: z.string(),
        k: z.number().default(10),
        source: z.string().optional(),
        item_id: z.number().optional(),
      },
      async ({ query, k, source, item_id }) => {
        if (!query.trim()) return { content: [{ type: "text", text: "[]" }] };
        const safeK = Math.min(Math.max(k, 1), 50);

        const [qvec] = await embedTexts(env, [query]);
        if (!qvec) return { content: [{ type: "text", text: "[]" }] };

        const matches = await env.VECTORIZE.query(qvec, { topK: safeK * 4, returnMetadata: "all" });

        const rows = await all<{ item_id: number }>(
          env.DB.prepare("SELECT item_id FROM user_item WHERE user_id = ?").bind(userId)
        );
        const savedIds = new Set(rows.map((r) => r.item_id));

        const hits: Record<string, unknown>[] = [];
        for (const m of matches.matches) {
          const chunkId = Number(m.id);
          const meta = (m.metadata || {}) as Record<string, unknown>;
          const itemId = Number(meta.item_id);
          
          if (!savedIds.has(itemId)) continue;
          if (item_id && itemId !== item_id) continue;
          if (source && meta.source !== source) continue;

          const row = await env.DB.prepare(
            `SELECT ch.id AS chunk_id, ch.item_id, ch.source, ch.field, ch.text,
                    ch.start_s, ch.end_s, i.title, i.source_url, i.platform, i.author
               FROM chunk ch JOIN item i ON i.id = ch.item_id
              WHERE ch.id = ?`
          ).bind(chunkId).first<Record<string, unknown>>();
          
          if (!row) continue;
          
          let deep_link: string | null = null;
          const start = row.start_s as number | null;
          const url = row.source_url as string;
          if (start != null && url) {
            if (row.platform === "youtube" || row.platform === "bilibili") {
              const sep = url.includes("?") ? "&" : "?";
              deep_link = `${url}${sep}t=${Math.floor(start)}s`;
            }
          }
          
          hits.push({ ...row, score: m.score, deep_link });
          if (hits.length >= safeK) break;
        }

        return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
      }
    );

    server.tool(
      "get_item",
      { item_id: z.number() },
      async ({ item_id }) => {
        const item = await first<any>(env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(item_id));
        if (!item) throw new Error(`item ${item_id} not found`);

        const summary = await first<any>(env.DB.prepare("SELECT * FROM summary WHERE item_id = ?").bind(item_id));
        const transcript = await first<any>(env.DB.prepare("SELECT * FROM transcript WHERE item_id = ?").bind(item_id));

        const data = _brief(item);
        Object.assign(data, {
          description: item.description,
          error: item.error,
          view_count: item.view_count,
          like_count: item.like_count,
          total_cost_usd: item.total_cost_usd,
          total_tokens: item.total_tokens,
          has_transcript: !!transcript,
          transcript_language: transcript ? transcript.language : null,
          summary_markdown: summary ? summary.markdown : null,
          summary: summary ? JSON.parse(summary.structured || "{}") : null,
        });

        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    );

    return createMcpHandler(server)(request, env, ctx);
  }
};
