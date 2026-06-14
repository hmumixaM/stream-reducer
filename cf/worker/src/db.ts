import type { Env } from "./env";

// --- Row shapes (mirror migrations/0001_init.sql) -------------------------

export interface UserRow {
  id: number;
  email: string;
  is_admin: number;
  created_at: string;
}

export interface ItemRow {
  id: number;
  platform: string;
  source_url: string;
  external_id: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  duration_s: number | null;
  published_at: string | null;
  thumbnail: string | null;
  view_count: number | null;
  like_count: number | null;
  dislike_count: number | null;
  status: string;
  error: string | null;
  request_count: number;
  interest_count: number;
  subscriber_demand: number;
  priority_score: number;
  media_key: string | null;
  media_bytes: number;
  audio_duration_s: number | null;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  total_processing_ms: number;
  total_api_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  retry_count: number;
  created_at: string;
}

export interface UserItemRow {
  id: number;
  user_id: number;
  item_id: number;
  folder_id: number | null;
  group_position: number | null;
  is_favorite: number;
  is_archived: number;
  personal_status: string;
  subscription_id: number | null;
  added_at: string;
}

export interface SubscriptionRow {
  id: number;
  user_id: number;
  platform: string;
  feed_url: string;
  title: string | null;
  interval_minutes: number;
  window_days: number;
  min_published_at: string | null;
  enabled: number;
  last_checked_at: string | null;
  last_seen_guid: string | null;
  created_at: string;
}

// --- Thin query helpers ---------------------------------------------------

export async function first<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  const res = await stmt.all<T>();
  return res.results ?? [];
}

export function db(env: Env) {
  return env.DB;
}

// Find-or-create a global item for a normalized URL. Returns the row and
// whether it was freshly created (used to decide whether to enqueue).
export async function upsertItem(
  env: Env,
  opts: {
    source_url: string;
    platform: string;
    title?: string | null;
    external_id?: string | null;
  },
): Promise<{ item: ItemRow; created: boolean }> {
  if (opts.external_id) {
    const existingByExternal = await first<ItemRow>(
      env.DB.prepare(
        "SELECT * FROM item WHERE platform = ? AND external_id = ? ORDER BY id LIMIT 1",
      ).bind(opts.platform, opts.external_id),
    );
    if (existingByExternal) return { item: existingByExternal, created: false };
  }

  const existing = await first<ItemRow>(
    env.DB.prepare("SELECT * FROM item WHERE source_url = ?").bind(opts.source_url),
  );
  if (existing) return { item: existing, created: false };

  await env.DB.prepare(
    `INSERT INTO item (platform, source_url, title, external_id, status)
     VALUES (?, ?, ?, ?, 'queued')
     ON CONFLICT(source_url) DO NOTHING`,
  )
    .bind(opts.platform, opts.source_url, opts.title ?? null, opts.external_id ?? null)
    .run();

  const item = await first<ItemRow>(
    env.DB.prepare("SELECT * FROM item WHERE source_url = ?").bind(opts.source_url),
  );
  if (!item) throw new Error("failed to upsert item");
  return { item, created: existing === null };
}
