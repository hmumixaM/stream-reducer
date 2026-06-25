import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth, resolveUser } from "../auth";
import { all, first, type ItemRow, type UserItemRow } from "../db";
import { toItemRead } from "../lib/serialize";
import { addUrlToLibrary, expandPlaylistUrls, recomputePriority } from "../lib/ingest";
import { splitUrls, nonItemUrlError } from "../lib/url";
import { readJson } from "../lib/request";

export const itemsRoutes = new Hono<AppContext>();

// Read-only catalog endpoints (browse list, item detail, related) are public so
// anyone can explore the content without an account. Per-user state (library,
// favorites, comments, highlights) requires auth and is applied per-route.

const SORT_COLUMNS: Record<string, string> = {
  added: "item.created_at",
  published: "item.published_at",
  views: "item.view_count",
  likes: "item.like_count",
  duration: "item.duration_s",
  priority: "item.priority_score",
};

// --- Browse the GLOBAL catalog (every item anyone has ingested) ----------
itemsRoutes.get("/", async (c) => {
  const u = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (u.status) {
    where.push("item.status = ?");
    binds.push(u.status);
  } else {
    // Hide membership/paid-gated (members-only) items from the public catalog.
    where.push("item.status != 'excluded'");
  }
  if (u.platform) {
    where.push("item.platform = ?");
    binds.push(u.platform);
  }
  if (u.q) {
    where.push("item.title LIKE ?");
    binds.push(`%${u.q}%`);
  }
  const sortCol = SORT_COLUMNS[u.sort ?? "added"] ?? "item.created_at";
  const order = u.order === "asc" ? "ASC" : "DESC";
  const limit = Math.min(Number(u.limit ?? 100), 500);
  const offset = Number(u.offset ?? 0);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Anonymous browsing is allowed: with no session the LEFT JOIN simply finds
  // no per-user rows (user id -1 never matches), so items render as un-saved.
  const user = await resolveUser(c.env, c);
  const userId = user?.id ?? -1;
  const rows = await all<ItemRow & { _ui_id: number | null; ui_is_favorite: number | null; ui_is_archived: number | null; ui_folder_id: number | null; ui_status: string | null; _interest_id: number | null }>(
    c.env.DB.prepare(
      `SELECT item.*, ui.id AS _ui_id, ui.is_favorite AS ui_is_favorite,
              ui.is_archived AS ui_is_archived, ui.folder_id AS ui_folder_id,
              ui.personal_status AS ui_status, ii.id AS _interest_id
         FROM item
         LEFT JOIN user_item ui ON ui.item_id = item.id AND ui.user_id = ?
         LEFT JOIN item_interest ii ON ii.item_id = item.id AND ii.user_id = ?
         ${whereSql}
         ORDER BY ${sortCol} ${order}, item.created_at DESC
         LIMIT ? OFFSET ?`,
    ).bind(userId, userId, ...binds, limit, offset),
  );
  return c.json(
    rows.map((r) =>
      toItemRead(
        r,
        r._ui_id
          ? {
              folder_id: r.ui_folder_id,
              is_favorite: r.ui_is_favorite ?? 0,
              is_archived: r.ui_is_archived ?? 0,
              personal_status: r.ui_status ?? "waiting",
              subscription_id: null,
              group_position: null,
            }
          : null,
        { is_interested: r._interest_id != null },
      ),
    ),
  );
});

// --- The signed-in user's personal library ------------------------------
itemsRoutes.get("/library", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const u = c.req.query();
  const where: string[] = ["ui.user_id = ?"];
  const binds: unknown[] = [userId];
  if (u.favorite !== undefined) {
    where.push("ui.is_favorite = ?");
    binds.push(u.favorite === "true" ? 1 : 0);
  }
  if (u.archived !== undefined) {
    where.push("ui.is_archived = ?");
    binds.push(u.archived === "true" ? 1 : 0);
  }
  if (u.group_id !== undefined) {
    where.push("ui.folder_id = ?");
    binds.push(Number(u.group_id));
  }
  if (u.subscription_id !== undefined) {
    where.push("ui.subscription_id = ?");
    binds.push(Number(u.subscription_id));
  }
  if (u.ungrouped === "true") where.push("ui.folder_id IS NULL");
  if (u.status) {
    where.push("item.status = ?");
    binds.push(u.status);
  }
  if (u.q) {
    where.push("item.title LIKE ?");
    binds.push(`%${u.q}%`);
  }
  const sortCol = SORT_COLUMNS[u.sort ?? "added"] ?? "item.created_at";
  const order = u.order === "asc" ? "ASC" : "DESC";
  const limit = Math.min(Number(u.limit ?? 200), 500);
  const offset = Number(u.offset ?? 0);

  const rows = await all<ItemRow & UserItemRowAlias>(
    c.env.DB.prepare(
      `SELECT item.*, ui.id AS ui_id, ui.folder_id AS folder_id,
              ui.group_position AS group_position, ui.is_favorite AS is_favorite,
              ui.is_archived AS is_archived, ui.personal_status AS personal_status,
              ui.subscription_id AS subscription_id, ii.id AS _interest_id
         FROM user_item ui
         JOIN item ON item.id = ui.item_id
         LEFT JOIN item_interest ii ON ii.item_id = item.id AND ii.user_id = ui.user_id
         WHERE ${where.join(" AND ")}
         ORDER BY ${sortCol} ${order}, ui.added_at DESC
         LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset),
  );
  return c.json(
    rows.map((r) =>
      toItemRead(r, r, { is_interested: r._interest_id != null }),
    ),
  );
});

interface UserItemRowAlias {
  ui_id: number;
  folder_id: number | null;
  group_position: number | null;
  is_favorite: number;
  is_archived: number;
  personal_status: string;
  subscription_id: number | null;
  _interest_id: number | null;
}

interface StageRunRow {
  id: number;
  item_id: number;
  stage: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  attempts: number;
  provider: string | null;
  model: string | null;
  request_count: number;
  chunk_count: number;
  chunk_done: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  http_429_count: number;
  error: string | null;
}

interface CommentRow {
  id: number;
  item_id: number;
  user_id: number;
  body: string;
  created_at: string;
}

interface HighlightRow {
  id: number;
  item_id: number;
  user_id: number;
  source: string;
  quote: string;
  note: string;
  color: string;
  prefix: string;
  suffix: string;
  created_at: string;
}

interface TranslationRow {
  lang: string;
  status: string;
  model: string | null;
  markdown: string;
  structured: string;
  error: string | null;
  updated_at: string;
}

interface RelatedItemRow {
  id: number;
  item_id: number;
  title: string | null;
  platform: string;
  author: string | null;
  thumbnail: string | null;
  source_url: string;
  score: number;
}

// Add one or more URLs to the user's library (dedup + enqueue).
itemsRoutes.post("/library", requireAuth, async (c) => {
  const body = await readJson<{
    url?: string;
    urls?: string[];
    folder_id?: number;
  }>(c);
  const raw: string[] = [...(body.urls ?? [])];
  if (body.url) raw.push(body.url);
  const inputUrls = raw.flatMap((entry) => splitUrls(entry));
  if (!inputUrls.length) return c.json({ error: "no urls provided" }, 400);

  // Expand Bilibili 合集/系列 lists into their member videos so a whole list can
  // be added directly (each episode becomes its own library item). Non-list URLs
  // pass through untouched.
  const urls: string[] = [];
  for (const inputUrl of inputUrls) {
    const expanded = await expandPlaylistUrls(c.env, inputUrl);
    if (expanded === null) {
      urls.push(inputUrl);
    } else if (expanded.length === 0) {
      return c.json({ error: `Couldn't read any videos from this Bilibili list: ${inputUrl}` }, 400);
    } else {
      urls.push(...expanded);
    }
  }

  // Reject channel/feed links: only single videos/episodes (or expanded list
  // members) can be added to the library (bare channels belong in subscriptions).
  // All-or-nothing so the user gets a clear error instead of a silently-skipped link.
  const invalid = urls
    .map((url) => ({ url, error: nonItemUrlError(url) }))
    .filter((x): x is { url: string; error: string } => x.error !== null);
  if (invalid.length) {
    return c.json(
      { error: invalid.map((x) => x.error).join(" "), invalid },
      400,
    );
  }

  const userId = c.get("user").id;
  const created: ReturnType<typeof toItemRead>[] = [];
  for (const url of urls) {
    const addResult = await addUrlToLibrary(c.env, userId, url, { folderId: body.folder_id ?? null });
    if (addResult) created.push(toItemRead(addResult.item));
  }
  return c.json(created);
});

// Item detail: global content + this user's comments/highlights + user_item.
// Public: anonymous visitors get the global content with empty personal state.
itemsRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const user = await resolveUser(c.env, c);
  const userId = user?.id ?? -1;
  const item = await first<ItemRow>(c.env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(id));
  if (!item) return c.json({ error: "item not found" }, 404);
  // Members-only/paid-gated content is hidden everywhere (can't be viewed).
  if (item.status === "excluded") return c.json({ error: "item not found" }, 404);
  const ui = await first<UserItemRow>(
    c.env.DB.prepare("SELECT * FROM user_item WHERE user_id = ? AND item_id = ?").bind(userId, id),
  );
  const summary = await first<{ id: number; model: string; prompt_version: string; markdown: string; structured: string; created_at: string }>(
    c.env.DB.prepare("SELECT * FROM summary WHERE item_id = ?").bind(id),
  );
  const transcript = await first<{ id: number; language: string | null; source: string; segments: string; text: string }>(
    c.env.DB.prepare("SELECT * FROM transcript WHERE item_id = ?").bind(id),
  );
  const stages = await all<StageRunRow>(
    c.env.DB.prepare("SELECT * FROM stage_run WHERE item_id = ? ORDER BY id").bind(id),
  );
  const comments = await all<CommentRow>(
    c.env.DB.prepare("SELECT * FROM comment WHERE item_id = ? AND user_id = ? ORDER BY created_at").bind(id, userId),
  );
  const highlights = await all<HighlightRow>(
    c.env.DB.prepare("SELECT * FROM highlight WHERE item_id = ? AND user_id = ? ORDER BY created_at").bind(id, userId),
  );
  const interested = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM item_interest WHERE user_id = ? AND item_id = ?").bind(userId, id),
  );
  // Available shared translations (status only; the body is fetched on demand).
  const translations = await all<{ lang: string; status: string }>(
    c.env.DB.prepare("SELECT lang, status FROM item_translation WHERE item_id = ? ORDER BY lang").bind(id),
  );
  // On-demand infographic poster (shared). Null until a user requests one.
  const infographic = await first<{ status: string; model: string; image_key: string | null; error: string | null }>(
    c.env.DB.prepare("SELECT status, model, image_key, error FROM item_infographic WHERE item_id = ?").bind(id),
  );

  return c.json({
    ...toItemRead(item, ui, { is_interested: interested != null }),
    summary: summary
      ? { ...summary, structured: JSON.parse(summary.structured || "{}") }
      : null,
    transcript: transcript
      ? { ...transcript, segments: JSON.parse(transcript.segments || "[]") }
      : null,
    stages,
    comments,
    highlights,
    translations,
    infographic: infographic
      ? {
          status: infographic.status,
          model: infographic.model,
          error: infographic.error,
          image_url: infographic.image_key ? `/media/${infographic.image_key}` : null,
        }
      : null,
  });
});

// Supported on-demand translation languages (kept in sync with the frontend).
const TRANSLATE_LANGS = new Set(["en", "zh", "ja", "ko", "es", "fr", "de", "ru"]);

// Fetch a shared translation's body (public). 404 when it doesn't exist yet.
itemsRoutes.get("/:id/translation", async (c) => {
  const id = Number(c.req.param("id"));
  const lang = (c.req.query("lang") || "").trim();
  const row = await first<TranslationRow>(
    c.env.DB.prepare("SELECT lang, status, model, markdown, structured, error, updated_at FROM item_translation WHERE item_id = ? AND lang = ?").bind(id, lang),
  );
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ ...row, structured: JSON.parse(row.structured || "{}") });
});

// Request a translation (auth'd). Idempotent: returns the existing row, or
// creates a queued one + enqueues the job. Shared across all users.
itemsRoutes.post("/:id/translate", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<{ lang?: string }>(c);
  const lang = (body.lang || "").trim();
  if (!TRANSLATE_LANGS.has(lang)) return c.json({ error: "unsupported language" }, 400);

  const item = await first<ItemRow>(c.env.DB.prepare("SELECT id, status FROM item WHERE id = ?").bind(id));
  if (!item) return c.json({ error: "item not found" }, 404);
  const transcript = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM transcript WHERE item_id = ?").bind(id),
  );
  if (!transcript) return c.json({ error: "item has no transcript yet" }, 409);

  const existing = await first<{ status: string }>(
    c.env.DB.prepare("SELECT status FROM item_translation WHERE item_id = ? AND lang = ?").bind(id, lang),
  );
  // Re-enqueue only when missing or previously errored.
  if (!existing || existing.status === "error") {
    await c.env.DB.prepare(
      `INSERT INTO item_translation (item_id, lang, status) VALUES (?, ?, 'queued')
       ON CONFLICT(item_id, lang) DO UPDATE SET status='queued', error=NULL, updated_at=excluded.updated_at`,
    ).bind(id, lang).run();
    await c.env.PIPELINE.send({ kind: "translate", item_id: id, lang });
    return c.json({ lang, status: "queued" });
  }
  return c.json({ lang, status: existing.status });
});

// Fetch the shared infographic's status + image URL (public). 404 when none.
itemsRoutes.get("/:id/infographic", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await first<{ status: string; model: string; image_key: string | null; error: string | null; updated_at: string }>(
    c.env.DB.prepare(
      "SELECT status, model, image_key, error, updated_at FROM item_infographic WHERE item_id = ?",
    ).bind(id),
  );
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    status: row.status,
    model: row.model,
    error: row.error,
    updated_at: row.updated_at,
    image_url: row.image_key ? `/media/${row.image_key}` : null,
  });
});

// Request an infographic (auth'd). Idempotent: returns the existing row, or
// creates a queued one + enqueues the job. Shared across all users. Image
// generation is paid (~$0.13/image), so it's only ever triggered on demand.
itemsRoutes.post("/:id/infographic", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const item = await first<ItemRow>(c.env.DB.prepare("SELECT id FROM item WHERE id = ?").bind(id));
  if (!item) return c.json({ error: "item not found" }, 404);
  const summary = await first<{ item_id: number }>(
    c.env.DB.prepare("SELECT item_id FROM summary WHERE item_id = ?").bind(id),
  );
  if (!summary) return c.json({ error: "item has no summary yet" }, 409);

  const existing = await first<{ status: string }>(
    c.env.DB.prepare("SELECT status FROM item_infographic WHERE item_id = ?").bind(id),
  );
  // Re-enqueue only when missing or previously errored (don't burn money twice).
  if (!existing || existing.status === "error") {
    await c.env.DB.prepare(
      `INSERT INTO item_infographic (item_id, status) VALUES (?, 'queued')
       ON CONFLICT(item_id) DO UPDATE SET status='queued', error=NULL, updated_at=excluded.updated_at`,
    ).bind(id).run();
    await c.env.PIPELINE.send({ kind: "infographic", item_id: id });
    return c.json({ status: "queued", image_url: null });
  }
  return c.json({ status: existing.status, image_url: null });
});

// Related articles (global recommendations) for an item.
itemsRoutes.get("/:id/related", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await all<RelatedItemRow>(
    c.env.DB.prepare(
      `SELECT r.related_item_id AS item_id, r.score,
              i.id, i.title, i.platform, i.author, i.thumbnail, i.source_url
         FROM item_recommendation r JOIN item i ON i.id = r.related_item_id
        WHERE r.item_id = ? ORDER BY r.score DESC LIMIT 12`,
    ).bind(id),
  );
  return c.json(rows);
});

// Re-enqueue processing for a global item (signed-in users may trigger it).
itemsRoutes.post("/:id/retry", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const item = await first<ItemRow>(c.env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(id));
  if (!item) return c.json({ error: "item not found" }, 404);
  await c.env.DB.prepare("UPDATE item SET status = 'queued', error = NULL WHERE id = ?").bind(id).run();
  await c.env.PIPELINE.send({ kind: "process", item_id: id });
  return c.json(toItemRead({ ...item, status: "queued", error: null }));
});

itemsRoutes.post("/:id/regenerate", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const item = await first<ItemRow>(c.env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(id));
  if (!item) return c.json({ error: "item not found" }, 404);
  const transcript = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM transcript WHERE item_id = ?").bind(id),
  );
  if (transcript) {
    await c.env.DB.prepare("UPDATE item SET status = 'summarizing', error = NULL WHERE id = ?").bind(id).run();
    await c.env.PIPELINE.send({ kind: "resummarize", item_id: id });
  } else {
    await c.env.DB.prepare("UPDATE item SET status = 'queued', error = NULL WHERE id = ?").bind(id).run();
    await c.env.PIPELINE.send({ kind: "process", item_id: id });
  }
  return c.json(toItemRead(item));
});

// --- Per-user library mutations -----------------------------------------
itemsRoutes.post("/:id/favorite", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  await c.env.DB.prepare(
    "UPDATE user_item SET is_favorite = 1 - is_favorite WHERE user_id = ? AND item_id = ?",
  ).bind(userId, id).run();
  return reloadItem(c, id, userId);
});

itemsRoutes.post("/:id/archive", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  await c.env.DB.prepare(
    "UPDATE user_item SET is_archived = 1 - is_archived WHERE user_id = ? AND item_id = ?",
  ).bind(userId, id).run();
  return reloadItem(c, id, userId);
});

itemsRoutes.post("/:id/group", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  const body = await readJson<{ group_id?: number | null }>(c);
  await c.env.DB.prepare(
    "UPDATE user_item SET folder_id = ? WHERE user_id = ? AND item_id = ?",
  ).bind(body.group_id ?? null, userId, id).run();
  return reloadItem(c, id, userId);
});

itemsRoutes.post("/:id/interest", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  const existing = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM item_interest WHERE user_id = ? AND item_id = ?").bind(userId, id),
  );
  if (existing) {
    await c.env.DB.prepare("DELETE FROM item_interest WHERE id = ?").bind(existing.id).run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO item_interest (user_id, item_id) VALUES (?, ?) ON CONFLICT(user_id, item_id) DO NOTHING",
    ).bind(userId, id).run();
  }
  await recomputePriority(c.env, id);
  return reloadItem(c, id, userId);
});

itemsRoutes.delete("/:id/media", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  const ui = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM user_item WHERE user_id = ? AND item_id = ?").bind(userId, id),
  );
  if (!ui) return c.json({ error: "item not in your library" }, 404);

  const item = await first<ItemRow>(
    c.env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(id),
  );
  if (!item) return c.json({ error: "item not found" }, 404);
  if (item.media_key) await c.env.MEDIA.delete(item.media_key);
  await c.env.DB.prepare(
    "UPDATE item SET media_key = NULL, media_bytes = 0, audio_duration_s = NULL WHERE id = ?",
  ).bind(id).run();
  return reloadItem(c, id, userId);
});

// Remove an item from the user's library (the global content stays).
itemsRoutes.delete("/:id", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const userId = c.get("user").id;
  await c.env.DB.prepare("DELETE FROM user_item WHERE user_id = ? AND item_id = ?").bind(userId, id).run();
  await c.env.DB.prepare("DELETE FROM comment WHERE user_id = ? AND item_id = ?").bind(userId, id).run();
  await c.env.DB.prepare("DELETE FROM highlight WHERE user_id = ? AND item_id = ?").bind(userId, id).run();
  await recomputePriority(c.env, id);
  return c.json({ ok: true });
});

async function reloadItem(c: Parameters<typeof requireAuth>[0], id: number, userId: number) {
  const item = await first<ItemRow>(c.env.DB.prepare("SELECT * FROM item WHERE id = ?").bind(id));
  const ui = await first<UserItemRow>(
    c.env.DB.prepare("SELECT * FROM user_item WHERE user_id = ? AND item_id = ?").bind(userId, id),
  );
  if (!item) return c.json({ error: "item not found" }, 404);
  const interested = await first<{ id: number }>(
    c.env.DB.prepare("SELECT id FROM item_interest WHERE user_id = ? AND item_id = ?").bind(userId, id),
  );
  return c.json(toItemRead(item, ui, { is_interested: interested != null }));
}
