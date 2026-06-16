import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { all, first, type ItemRow } from "../db";
import { addUrlToLibrary } from "../lib/ingest";
import { splitUrls } from "../lib/url";
import { embedTexts } from "../lib/embed";

// Props carried in the OAuth access token, surfaced on `ctx.props` for every
// authenticated request (set in routes/oauth.ts on consent).
interface McpProps {
  userId: number;
}

// Compact, token-cheap view of an item for list/add responses.
function brief(item: ItemRow) {
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

function deepLink(row: { start_s: number | null; source_url: string; platform: string }): string | null {
  const { start_s, source_url, platform } = row;
  if (start_s == null || !source_url) return null;
  if (platform === "youtube" || platform === "bilibili") {
    const sep = source_url.includes("?") ? "&" : "?";
    return `${source_url}${sep}t=${Math.floor(start_s)}s`;
  }
  return null;
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

interface SearchArgs {
  query: string;
  k: number;
  source?: string;
  item_id?: number;
}

// Semantic search over chunk embeddings. When `libraryUserId` is set, results
// are restricted to that user's saved items; otherwise the whole catalog is
// searched. Over-fetches from Vectorize so post-filtering (library / source /
// item) still returns up to `k` hits.
async function runSearch(
  env: Env,
  { query, k, source, item_id }: SearchArgs,
  libraryUserId: number | null,
) {
  if (!query.trim()) return text([]);
  const safeK = Math.min(Math.max(k, 1), 50);

  const [qvec] = await embedTexts(env, [query]);
  if (!qvec) return text([]);

  const matches = await env.VECTORIZE.query(qvec, { topK: safeK * 4, returnMetadata: "all" });

  let savedIds: Set<number> | null = null;
  if (libraryUserId != null) {
    const saved = await all<{ item_id: number }>(
      env.DB.prepare("SELECT item_id FROM user_item WHERE user_id = ?").bind(libraryUserId),
    );
    savedIds = new Set(saved.map((r) => r.item_id));
  }

  const hits: Record<string, unknown>[] = [];
  for (const m of matches.matches) {
    const meta = (m.metadata || {}) as Record<string, unknown>;
    const itemId = Number(meta.item_id);
    if (savedIds && !savedIds.has(itemId)) continue;
    if (item_id && itemId !== item_id) continue;
    if (source && meta.source !== source) continue;

    const row = await first<{
      chunk_id: number;
      item_id: number;
      source: string;
      field: string;
      text: string;
      start_s: number | null;
      end_s: number | null;
      title: string | null;
      source_url: string;
      platform: string;
      author: string | null;
    }>(
      env.DB.prepare(
        `SELECT ch.id AS chunk_id, ch.item_id, ch.source, ch.field, ch.text,
                ch.start_s, ch.end_s, i.title, i.source_url, i.platform, i.author
           FROM chunk ch JOIN item i ON i.id = ch.item_id
          WHERE ch.id = ?`,
      ).bind(Number(m.id)),
    );
    if (!row) continue;

    hits.push({ ...row, score: m.score, deep_link: deepLink(row) });
    if (hits.length >= safeK) break;
  }
  return text(hits);
}

const SEARCH_INPUT_SCHEMA = {
  query: z.string().min(1),
  k: z.number().int().default(10),
  source: z.string().optional(),
  item_id: z.number().int().optional(),
} as const;

// Build the per-request MCP server. A fresh instance per request is required
// for stateless MCP on Workers (shared instances can leak one client's response
// to another), and it lets the tools close over the authenticated `userId`.
function buildServer(env: Env, userId: number): McpServer {
  const server = new McpServer({ name: "stream-reduce", version: "1.0.0" });

  server.registerTool(
    "add_content",
    {
      description:
        "Add media to your library and queue it for transcription + summarization. " +
        "Accepts one or more URLs (YouTube, Bilibili, Apple Podcasts, Xiaoyuzhou, RSS). " +
        "A playlist or whole podcast show expands into its episodes. Returns the queued items.",
      inputSchema: { urls: z.array(z.string()).min(1) },
    },
    async ({ urls }) => {
      const out: ReturnType<typeof brief>[] = [];
      const seen = new Set<number>();
      for (const url of urls.flatMap((entry) => splitUrls(entry))) {
        const res = await addUrlToLibrary(env, userId, url, { folderId: null });
        if (res && !seen.has(res.item.id)) {
          seen.add(res.item.id);
          out.push(brief(res.item));
        }
      }
      return text(out);
    },
  );

  server.registerTool(
    "list_items",
    {
      description:
        "List items in your library (most recently added first). Optional filters: " +
        "`query` matches the title; `status` is one of queued/fetching/transcribing/" +
        "summarizing/done/error; `platform` is one of youtube/bilibili/apple_podcast/" +
        "xiaoyuzhou/rss.",
      inputSchema: {
        query: z.string().optional(),
        status: z.string().optional(),
        platform: z.string().optional(),
        limit: z.number().int().default(20),
      },
    },
    async ({ query, status, platform, limit }) => {
      const where = ["ui.user_id = ?"];
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
      const rows = await all<ItemRow>(
        env.DB.prepare(
          `SELECT item.*
             FROM user_item ui
             JOIN item ON item.id = ui.item_id
             WHERE ${where.join(" AND ")}
             ORDER BY ui.added_at DESC
             LIMIT ?`,
        ).bind(...binds, safeLimit),
      );
      return text(rows.map(brief));
    },
  );

  server.registerTool(
    "search_content",
    {
      description:
        "Semantic search across the transcripts + summaries of items in YOUR library only. " +
        "Returns the most relevant chunks (not whole items), each with the chunk `text`, " +
        "its `item_id`/`title`/`source_url`, a `source` (transcript/summary) + `field` tag, " +
        "a similarity `score`, and — for transcript hits — `start_s` plus a `deep_link` that " +
        "jumps to that moment. Optional filters: `source` (\"transcript\"/\"summary\") and " +
        "`item_id` (restrict to one item). Use `search_all_content` to search every item in " +
        "the catalog, not just your library.",
      inputSchema: SEARCH_INPUT_SCHEMA,
    },
    async (args) => runSearch(env, args, userId),
  );

  server.registerTool(
    "search_all_content",
    {
      description:
        "Semantic search across the transcripts + summaries of EVERY item in the whole " +
        "stream-reduce catalog (shared across all users), not just your own library. " +
        "Same result shape and filters as `search_content`: returns matching chunks with " +
        "`text`, `item_id`/`title`/`source_url`, `source`/`field`, `score`, and a `deep_link` " +
        "for transcript hits. Optional filters: `source` and `item_id`.",
      inputSchema: SEARCH_INPUT_SCHEMA,
    },
    async (args) => runSearch(env, args, null),
  );

  server.registerTool(
    "get_item",
    {
      description:
        "Get full details for one item, including the summary (markdown + structured " +
        "TL;DR/outline/key points/quotes) and transcript availability.",
      inputSchema: { item_id: z.number().int() },
    },
    async ({ item_id }) => {
      const item = await first<ItemRow>(env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(item_id));
      if (!item) throw new Error(`item ${item_id} not found`);

      const summary = await first<{ markdown: string; structured: string }>(
        env.DB.prepare("SELECT markdown, structured FROM summary WHERE item_id = ?").bind(item_id),
      );
      const transcript = await first<{ language: string | null }>(
        env.DB.prepare("SELECT language FROM transcript WHERE item_id = ?").bind(item_id),
      );

      return text({
        ...brief(item),
        description: item.description,
        error: item.error,
        view_count: item.view_count,
        like_count: item.like_count,
        total_cost_usd: item.total_cost_usd,
        total_tokens: item.total_tokens,
        has_transcript: transcript != null,
        transcript_language: transcript?.language ?? null,
        summary_markdown: summary?.markdown ?? null,
        summary: summary ? JSON.parse(summary.structured || "{}") : null,
      });
    },
  );

  return server;
}

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // The OAuth provider validated the bearer token and put the grant's props
    // (set during consent) on ctx.props before routing here.
    const props = (ctx as ExecutionContext & { props?: McpProps }).props;
    const userId = props?.userId;
    if (userId == null) {
      return new Response(JSON.stringify({ error: "missing user in token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return createMcpHandler(buildServer(env, userId))(request, env, ctx);
  },
};
