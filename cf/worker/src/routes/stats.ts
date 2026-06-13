import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";

export const statsRoutes = new Hono<AppContext>();
statsRoutes.use("*", requireAuth);

// Aggregate stats over the global catalog + pipeline runs.
statsRoutes.get("/", async (c) => {
  const refresh = c.req.query("refresh") === "true";
  const total = (await first<{ n: number }>(c.env.DB.prepare("SELECT COUNT(*) AS n FROM item")))?.n ?? 0;

  const byStatus = await all<{ status: string; n: number }>(
    c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM item GROUP BY status"),
  );
  const byPlatform = await all<{ platform: string; n: number }>(
    c.env.DB.prepare("SELECT platform, COUNT(*) AS n FROM item GROUP BY platform"),
  );
  const stages = await all<{ stage: string; n: number; avg_ms: number; total_ms: number; cost: number }>(
    c.env.DB.prepare(
      `SELECT stage, COUNT(*) AS n, AVG(duration_ms) AS avg_ms,
              SUM(duration_ms) AS total_ms, SUM(cost_usd) AS cost
         FROM stage_run GROUP BY stage`,
    ),
  );
  const tokens = await first<{ prompt: number; completion: number; total: number; cost: number; r429: number; reqs: number }>(
    c.env.DB.prepare(
      `SELECT SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion,
              SUM(total_tokens) AS total, SUM(cost_usd) AS cost,
              SUM(http_429_count) AS r429, SUM(request_count) AS reqs
         FROM stage_run`,
    ),
  );
  const dur = (await first<{ d: number }>(c.env.DB.prepare("SELECT SUM(duration_s) AS d FROM item")))?.d ?? 0;

  const items_by_status: Record<string, number> = {};
  for (const r of byStatus) items_by_status[r.status] = r.n;
  const items_by_platform: Record<string, number> = {};
  for (const r of byPlatform) items_by_platform[r.platform] = r.n;
  const avg_stage_ms: Record<string, number> = {};
  const total_stage_ms: Record<string, number> = {};
  const cost_by_stage: Record<string, number> = {};
  for (const s of stages) {
    avg_stage_ms[s.stage] = s.avg_ms ?? 0;
    total_stage_ms[s.stage] = s.total_ms ?? 0;
    cost_by_stage[s.stage] = s.cost ?? 0;
  }

  if (refresh) c.header("cache-control", "no-store");
  return c.json({
    total_items: total,
    items_by_status,
    items_by_platform,
    by_platform: byPlatform.map((p) => ({ platform: p.platform, items: p.n, done: 0, duration_s: 0, tokens: 0, cost_usd: 0 })),
    avg_stage_ms,
    total_stage_ms,
    cost_by_stage,
    total_duration_s: dur,
    transcript_words: 0,
    transcript_chars: 0,
    prompt_tokens: tokens?.prompt ?? 0,
    completion_tokens: tokens?.completion ?? 0,
    total_tokens: tokens?.total ?? 0,
    openrouter_requests: tokens?.reqs ?? 0,
    openrouter_tokens: 0,
    gemini_tokens: 0,
    total_cost_usd: tokens?.cost ?? 0,
    http_429_total: tokens?.r429 ?? 0,
  });
});
