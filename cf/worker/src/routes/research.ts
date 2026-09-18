import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first, type ItemRow, type ResearchAgentRow, type ResearchAskRow, type ResearchBriefRow, type ResearchCoverageRow } from "../db";
import type { Env } from "../env";
import { isoNow } from "../lib/crypto";
import { readJson } from "../lib/request";

export const researchRoutes = new Hono<AppContext>();
researchRoutes.use("*", requireAuth);

type ResearchItem = Pick<ItemRow, "id" | "title" | "headline" | "subhead" | "author" | "description" | "source_url" | "published_at"> & {
  summary_markdown: string | null;
  summary_structured: string | null;
};

type AskSource = {
  item_id: number;
  title: string;
  source_url: string;
  published_at: string | null;
};

function cleanLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 120) : "";
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function parseStructured(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function keyPoints(structured: Record<string, unknown>): string[] {
  const raw = structured.key_points;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((point) => {
      if (typeof point === "string") return point.trim();
      if (point && typeof point === "object" && "text" in point) return String(point.text ?? "").trim();
      return "";
    })
    .filter(Boolean)
    .slice(0, 6);
}

function bulletinItems(structured: Record<string, unknown>): string[] {
  const raw = structured.bulletin;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((point) => {
      if (typeof point === "string") return point.trim();
      if (point && typeof point === "object" && "text" in point) return String(point.text ?? "").trim();
      return "";
    })
    .filter(Boolean)
    .slice(0, 5);
}

function itemText(item: ResearchItem, structured: Record<string, unknown>): string {
  const fields = [
    item.title,
    item.headline,
    item.subhead,
    item.author,
    item.description,
    item.summary_markdown,
    structured.tldr,
    structured.background,
    ...bulletinItems(structured),
    ...keyPoints(structured),
  ];
  return fields.filter((field): field is string => typeof field === "string").join("\n").toLocaleLowerCase();
}

function termsFor(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))];
}

function matches(text: string, label: string): boolean {
  const normalizedLabel = normalize(label);
  if (!normalizedLabel) return false;
  if (text.includes(normalizedLabel)) return true;
  const terms = termsFor(normalizedLabel);
  return terms.length > 0 && terms.filter((term) => text.includes(term)).length >= Math.max(1, Math.ceil(terms.length / 2));
}

function briefSummary(item: ResearchItem, structured: Record<string, unknown>): { summary: string; bulletin: string[]; points: string[] } {
  const tldr = typeof structured.tldr === "string" ? structured.tldr.trim() : "";
  const summary = tldr || item.summary_markdown?.split("\n").map((line) => line.trim()).find(Boolean) || item.description || "New source captured in your coverage universe.";
  return { summary: summary.slice(0, 1200), bulletin: bulletinItems(structured), points: keyPoints(structured) };
}

function askSource(row: ResearchItem): AskSource {
  return {
    item_id: row.id,
    title: row.title || row.source_url,
    source_url: row.source_url,
    published_at: row.published_at,
  };
}

function rankSources(question: string, items: ResearchItem[]) {
  const terms = termsFor(question);
  return items
    .map((item) => {
      const structured = parseStructured(item.summary_structured);
      const text = itemText(item, structured);
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { item, structured, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.published_at ?? "").localeCompare(String(a.item.published_at ?? "")))
    .slice(0, 6);
}

function extractiveAnswer(question: string, items: ResearchItem[]): { answer: string; sources: AskSource[] } {
  const ranked = rankSources(question, items);
  if (!ranked.length) {
    return {
      answer: "I couldn't find a matching summary in your saved or followed content. Try adding a more specific name, theme, or question.",
      sources: [],
    };
  }
  const passages = ranked.map(({ item, structured }) => {
    const summary = briefSummary(item, structured);
    return `${item.title || item.source_url}: ${summary.bulletin.join(" ") || summary.summary}`;
  });
  const answer = `Based on ${ranked.length} matching source${ranked.length === 1 ? "" : "s"}:\n\n${passages.join("\n\n")}`;
  return { answer: answer.slice(0, 6000), sources: ranked.map(({ item }) => askSource(item)) };
}

async function answerWithModel(env: Env, question: string, items: ResearchItem[]): Promise<{ answer: string; sources: AskSource[] }> {
  const ranked = rankSources(question, items);
  const fallback = extractiveAnswer(question, items);
  if (!ranked.length || !env.LLM_BASE_URL || !env.GEMINI_API_KEY) return fallback;
  const context = ranked.map(({ item, structured }, index) => {
    const summary = briefSummary(item, structured);
    return `[${index + 1}] ${item.title || item.source_url}\nURL: ${item.source_url}\nBulletin: ${summary.bulletin.join("; ") || summary.summary}\nKey points: ${summary.points.join("; ")}`;
  }).join("\n\n");
  try {
    const response = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GEMINI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content: "You answer questions only from the provided source summaries. Do not invent facts. Write in the user's question language. Cite supporting sources inline as [1], [2]. If the sources are insufficient, say so clearly.",
          },
          { role: "user", content: `Question: ${question}\n\nSources:\n${context}` },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return fallback;
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    const answer = payload.choices?.[0]?.message?.content?.trim();
    return answer ? { answer: answer.slice(0, 6000), sources: ranked.map(({ item }) => askSource(item)) } : fallback;
  } catch {
    return fallback;
  }
}

async function recentItems(env: Env): Promise<ResearchItem[]> {
  return all<ResearchItem>(env.DB.prepare(
    `SELECT i.id, i.title, i.headline, i.subhead, i.author, i.description,
            i.source_url, i.published_at,
            s.markdown AS summary_markdown, s.structured AS summary_structured
       FROM item i
       LEFT JOIN summary s ON s.item_id = i.id
      WHERE i.status = 'done'
        AND julianday(COALESCE(i.published_at, i.created_at)) >= julianday('now', '-14 days')
      ORDER BY COALESCE(i.published_at, i.created_at) DESC
      LIMIT 200`,
  ));
}

async function userResearchItems(env: Env, userId: number): Promise<ResearchItem[]> {
  return all<ResearchItem>(env.DB.prepare(
    `SELECT DISTINCT i.id, i.title, i.headline, i.subhead, i.author, i.description,
            i.source_url, i.published_at,
            s.markdown AS summary_markdown, s.structured AS summary_structured
       FROM item i
       JOIN summary s ON s.item_id = i.id
       LEFT JOIN user_item ui ON ui.item_id = i.id AND ui.user_id = ?
       LEFT JOIN channel_item ci ON ci.item_id = i.id
       LEFT JOIN item_feed legacy_feed ON legacy_feed.item_id = i.id
       LEFT JOIN subscription sub
         ON sub.user_id = ? AND sub.enabled = 1
        AND (sub.channel_id = ci.channel_id OR sub.feed_url = legacy_feed.feed_url)
      WHERE i.status = 'done' AND (ui.id IS NOT NULL OR sub.id IS NOT NULL)
      ORDER BY COALESCE(i.published_at, i.created_at) DESC
      LIMIT 200`,
  ).bind(userId, userId));
}

async function assignmentsForUser(env: Env, userId: number): Promise<{ coverage: ResearchCoverageRow[]; agents: ResearchAgentRow[] }> {
  const [coverage, agents] = await Promise.all([
    all<ResearchCoverageRow>(env.DB.prepare("SELECT * FROM research_coverage WHERE user_id = ? ORDER BY id").bind(userId)),
    all<ResearchAgentRow>(env.DB.prepare("SELECT * FROM research_agent WHERE user_id = ? AND enabled = 1 ORDER BY id").bind(userId)),
  ]);
  return { coverage, agents };
}

async function insertBrief(
  env: Env,
  userId: number,
  item: ResearchItem,
  structured: Record<string, unknown>,
  input: { agentId?: number | null; coverageId?: number | null; type: string; label: string },
): Promise<boolean> {
  const agentId = input.agentId ?? null;
  const coverageId = input.coverageId ?? null;
  const exists = await first<{ id: number }>(env.DB.prepare(
    `SELECT id FROM research_brief
      WHERE user_id = ? AND item_id = ?
        AND ((agent_id = ?) OR (agent_id IS NULL AND ? IS NULL))
        AND ((coverage_id = ?) OR (coverage_id IS NULL AND ? IS NULL))
      LIMIT 1`,
  ).bind(userId, item.id, agentId, agentId, coverageId, coverageId));
  if (exists) return false;
  const rendered = briefSummary(item, structured);
  await env.DB.prepare(
    `INSERT INTO research_brief
       (user_id, agent_id, coverage_id, item_id, brief_type, title, summary, bulletin, key_points, matched_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    userId,
    agentId,
    coverageId,
    item.id,
    input.type,
    item.title || item.source_url,
    rendered.summary,
    JSON.stringify(rendered.bulletin),
    JSON.stringify(rendered.points),
    input.label,
  ).run();
  return true;
}

async function generateResearchFromItems(
  env: Env,
  userId: number,
  assignments: { coverage: ResearchCoverageRow[]; agents: ResearchAgentRow[] },
  items: ResearchItem[],
): Promise<number> {
  const { coverage, agents } = assignments;
  let created = 0;
  for (const item of items) {
    const structured = parseStructured(item.summary_structured);
    const text = itemText(item, structured);
    for (const target of coverage) {
      if (matches(text, target.label)) {
        if (await insertBrief(env, userId, item, structured, { coverageId: target.id, type: "appearance", label: target.label })) created++;
      }
    }
    for (const agent of agents) {
      const assignment = `${agent.name} ${agent.prompt}`.trim();
      if (matches(text, assignment)) {
        if (await insertBrief(env, userId, item, structured, { agentId: agent.id, type: agent.kind, label: agent.name })) created++;
      }
    }
  }
  return created;
}

/** Derive sourced briefs from summaries already in the shared catalog. */
export async function generateResearch(env: Env, userId: number): Promise<number> {
  const [assignments, items] = await Promise.all([assignmentsForUser(env, userId), recentItems(env)]);
  return generateResearchFromItems(env, userId, assignments, items);
}

/** Cron entry point. Research is derived from durable summaries, so a missed
 * run is harmless and the next tick can simply catch up. */
export async function generateResearchForAllUsers(env: Env): Promise<number> {
  const users = await all<{ id: number }>(env.DB.prepare(
    `SELECT user_id AS id FROM research_coverage
     UNION
     SELECT user_id AS id FROM research_agent WHERE enabled = 1
     ORDER BY id`,
  ));
  if (!users.length) return 0;
  const items = await recentItems(env);
  let created = 0;
  for (const user of users) {
    const assignments = await assignmentsForUser(env, user.id);
    created += await generateResearchFromItems(env, user.id, assignments, items);
  }
  return created;
}

function serializeCoverage(row: ResearchCoverageRow) {
  return { id: row.id, label: row.label, kind: row.kind, created_at: row.created_at };
}

function serializeAgent(row: ResearchAgentRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    prompt: row.prompt,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeBrief(row: ResearchBriefRow & { item_title?: string | null; source_url?: string | null; item_published_at?: string | null; agent_name?: string | null; coverage_label?: string | null }) {
  let bulletin: string[] = [];
  try {
    const parsed = JSON.parse(row.bulletin || "[]") as unknown;
    if (Array.isArray(parsed)) {
      bulletin = parsed.map((point) => {
        if (typeof point === "string") return point.trim();
        if (point && typeof point === "object" && "text" in point) return String(point.text ?? "").trim();
        return "";
      }).filter(Boolean).slice(0, 5);
    }
  } catch { /* keep an empty list for an old/corrupt row */ }
  let points: string[] = [];
  try {
    const parsed = JSON.parse(row.key_points || "[]") as unknown;
    if (Array.isArray(parsed)) points = parsed.map(String).filter(Boolean);
  } catch { /* keep an empty list for an old/corrupt row */ }
  return {
    id: row.id,
    item_id: row.item_id,
    title: row.title,
    summary: row.summary,
    bulletin,
    key_points: points,
    brief_type: row.brief_type,
    matched_text: row.matched_text,
    created_at: row.created_at,
    source_url: row.source_url ?? null,
    item_title: row.item_title ?? null,
    item_published_at: row.item_published_at ?? null,
    agent_name: row.agent_name ?? null,
    coverage_label: row.coverage_label ?? null,
  };
}

researchRoutes.get("/coverage", async (c) => {
  const rows = await all<ResearchCoverageRow>(c.env.DB.prepare("SELECT * FROM research_coverage WHERE user_id = ? ORDER BY label").bind(c.get("user").id));
  return c.json(rows.map(serializeCoverage));
});

researchRoutes.post("/coverage", async (c) => {
  const body = await readJson<{ label?: string; kind?: string }>(c);
  const label = cleanLabel(body.label);
  if (!label) return c.json({ error: "label required" }, 400);
  const normalized = normalize(label);
  await c.env.DB.prepare(
    `INSERT INTO research_coverage (user_id, label, normalized, kind)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, normalized) DO UPDATE SET label = excluded.label, kind = excluded.kind`,
  ).bind(c.get("user").id, label, normalized, body.kind === "ticker" ? "ticker" : "name").run();
  const row = await first<ResearchCoverageRow>(c.env.DB.prepare("SELECT * FROM research_coverage WHERE user_id = ? AND normalized = ?").bind(c.get("user").id, normalized));
  return c.json(serializeCoverage(row!));
});

researchRoutes.delete("/coverage/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM research_coverage WHERE id = ? AND user_id = ?").bind(Number(c.req.param("id")), c.get("user").id).run();
  if (!result.meta.changes) return c.json({ error: "coverage not found" }, 404);
  return c.json({ ok: true });
});

researchRoutes.get("/agents", async (c) => {
  const rows = await all<ResearchAgentRow>(c.env.DB.prepare("SELECT * FROM research_agent WHERE user_id = ? ORDER BY created_at DESC").bind(c.get("user").id));
  return c.json(rows.map(serializeAgent));
});

researchRoutes.post("/agents", async (c) => {
  const body = await readJson<{ name?: string; kind?: string; prompt?: string }>(c);
  const name = cleanLabel(body.name);
  const prompt = cleanLabel(body.prompt);
  if (!name) return c.json({ error: "name required" }, 400);
  if (name.length < 2) return c.json({ error: "name is too short" }, 400);
  const kind = body.kind === "custom" ? "custom" : "theme";
  const result = await c.env.DB.prepare("INSERT INTO research_agent (user_id, name, kind, prompt) VALUES (?, ?, ?, ?)").bind(c.get("user").id, name, kind, prompt || name).run();
  const row = await first<ResearchAgentRow>(c.env.DB.prepare("SELECT * FROM research_agent WHERE id = ? AND user_id = ?").bind(result.meta.last_row_id, c.get("user").id));
  return c.json(serializeAgent(row!));
});

researchRoutes.patch("/agents/:id", async (c) => {
  const body = await readJson<{ name?: string; prompt?: string; enabled?: boolean }>(c);
  const id = Number(c.req.param("id"));
  const current = await first<ResearchAgentRow>(c.env.DB.prepare("SELECT * FROM research_agent WHERE id = ? AND user_id = ?").bind(id, c.get("user").id));
  if (!current) return c.json({ error: "agent not found" }, 404);
  const name = body.name === undefined ? current.name : cleanLabel(body.name);
  const prompt = body.prompt === undefined ? current.prompt : cleanLabel(body.prompt);
  if (!name || !prompt) return c.json({ error: "name and prompt required" }, 400);
  await c.env.DB.prepare("UPDATE research_agent SET name = ?, prompt = ?, enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(name, prompt, body.enabled === undefined ? current.enabled : (body.enabled ? 1 : 0), isoNow(), id, c.get("user").id).run();
  const row = await first<ResearchAgentRow>(c.env.DB.prepare("SELECT * FROM research_agent WHERE id = ? AND user_id = ?").bind(id, c.get("user").id));
  return c.json(serializeAgent(row!));
});

researchRoutes.delete("/agents/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM research_agent WHERE id = ? AND user_id = ?").bind(Number(c.req.param("id")), c.get("user").id).run();
  if (!result.meta.changes) return c.json({ error: "agent not found" }, 404);
  return c.json({ ok: true });
});

researchRoutes.get("/feed", async (c) => {
  const userId = c.get("user").id;
  const limit = Math.min(Math.max(Number(c.req.query("limit") || 40), 1), 100);
  const rows = await all<ResearchBriefRow & { item_title: string | null; source_url: string | null; item_published_at: string | null; agent_name: string | null; coverage_label: string | null }>(c.env.DB.prepare(
    `SELECT b.*, i.title AS item_title, i.source_url, i.published_at AS item_published_at,
            a.name AS agent_name, cv.label AS coverage_label
       FROM research_brief b
       JOIN item i ON i.id = b.item_id
       LEFT JOIN research_agent a ON a.id = b.agent_id
       LEFT JOIN research_coverage cv ON cv.id = b.coverage_id
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
      LIMIT ?`,
  ).bind(userId, limit));
  return c.json(rows.map(serializeBrief));
});

researchRoutes.post("/run", async (c) => {
  const created = await generateResearch(c.env, c.get("user").id);
  return c.json({ ok: true, created, generated_at: isoNow() });
});

researchRoutes.post("/ask", async (c) => {
  const body = await readJson<{ question?: string }>(c);
  const question = cleanLabel(body.question).slice(0, 500);
  if (question.length < 3) return c.json({ error: "question required" }, 400);
  const userId = c.get("user").id;
  const usage = await first<{ count: number }>(c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM research_ask WHERE user_id = ? AND created_at >= datetime('now', '-1 day')",
  ).bind(userId));
  if ((usage?.count ?? 0) >= 20) return c.json({ error: "Daily research ask limit reached. Try again tomorrow." }, 429);
  const items = await userResearchItems(c.env, userId);
  const result = await answerWithModel(c.env, question, items);
  const inserted = await c.env.DB.prepare(
    "INSERT INTO research_ask (user_id, question, answer, sources) VALUES (?, ?, ?, ?)",
  ).bind(userId, question, result.answer, JSON.stringify(result.sources)).run();
  return c.json({
    id: inserted.meta.last_row_id,
    question,
    answer: result.answer,
    sources: result.sources,
    created_at: isoNow(),
  });
});

researchRoutes.get("/asks", async (c) => {
  const rows = await all<ResearchAskRow>(c.env.DB.prepare(
    "SELECT * FROM research_ask WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
  ).bind(c.get("user").id));
  return c.json(rows.map((row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    sources: parseSources(row.sources),
    created_at: row.created_at,
  })));
});

function parseSources(value: string): AskSource[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed) ? parsed as AskSource[] : [];
  } catch {
    return [];
  }
}

researchRoutes.get("/dossiers/:slug", async (c) => {
  const userId = c.get("user").id;
  const slug = normalize(decodeURIComponent(c.req.param("slug")));
  const coverage = await first<ResearchCoverageRow>(c.env.DB.prepare("SELECT * FROM research_coverage WHERE user_id = ? AND normalized = ?").bind(userId, slug));
  if (!coverage) return c.json({ error: "dossier not found" }, 404);
  const rows = await all<ResearchBriefRow & { item_title: string | null; source_url: string | null; item_published_at: string | null; agent_name: string | null; coverage_label: string | null }>(c.env.DB.prepare(
    `SELECT b.*, i.title AS item_title, i.source_url, i.published_at AS item_published_at,
            NULL AS agent_name, cv.label AS coverage_label
       FROM research_brief b
       JOIN item i ON i.id = b.item_id
       LEFT JOIN research_coverage cv ON cv.id = b.coverage_id
      WHERE b.user_id = ? AND b.coverage_id = ?
      ORDER BY COALESCE(i.published_at, b.created_at) DESC
      LIMIT 100`,
  ).bind(userId, coverage.id));
  return c.json({ coverage: serializeCoverage(coverage), mention_count: rows.length, mentions: rows.map(serializeBrief) });
});
