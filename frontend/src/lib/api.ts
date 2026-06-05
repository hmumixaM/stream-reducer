export type ItemStatus =
  | "queued"
  | "fetching"
  | "transcribing"
  | "summarizing"
  | "done"
  | "error";

export type Platform =
  | "youtube"
  | "bilibili"
  | "apple_podcast"
  | "xiaoyuzhou"
  | "rss"
  | "unknown";

export interface Item {
  id: number;
  platform: Platform;
  source_url: string;
  external_id?: string | null;
  title?: string | null;
  author?: string | null;
  description?: string | null;
  duration_s?: number | null;
  published_at?: string | null;
  thumbnail?: string | null;
  view_count?: number | null;
  like_count?: number | null;
  dislike_count?: number | null;
  status: ItemStatus;
  error?: string | null;
  subscription_id?: number | null;
  group_id?: number | null;
  group_position?: number | null;
  is_favorite: boolean;
  is_archived: boolean;
  media_bytes: number;
  audio_duration_s?: number | null;
  media_path?: string | null;
  enqueued_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  total_processing_ms: number;
  total_api_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  retry_count: number;
  created_at: string;
}

export interface QueueItem extends Item {
  current_stage?: string | null;
  chunk_done: number;
  chunk_count: number;
}

export interface StageRun {
  id: number;
  stage: string;
  status: string;
  started_at: string;
  finished_at?: string | null;
  duration_ms: number;
  attempts: number;
  provider?: string | null;
  model?: string | null;
  request_count: number;
  chunk_count: number;
  chunk_done: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  http_429_count: number;
  error?: string | null;
}

export interface Summary {
  id: number;
  model: string;
  prompt_version: string;
  markdown: string;
  structured: Record<string, unknown>;
  created_at: string;
}

export interface Transcript {
  id: number;
  language?: string | null;
  source: string;
  segments: { start: number; end: number; text: string }[];
  text: string;
}

export interface Comment {
  id: number;
  item_id: number;
  body: string;
  created_at: string;
}

export interface ItemDetail extends Item {
  summary?: Summary | null;
  transcript?: Transcript | null;
  stages: StageRun[];
  comments: Comment[];
}

export interface Group {
  id: number;
  platform: Platform;
  external_id?: string | null;
  source_url: string;
  title?: string | null;
  item_count: number;
  created_at: string;
}

export interface Subscription {
  id: number;
  platform: Platform;
  feed_url: string;
  title?: string | null;
  interval_minutes: number;
  enabled: boolean;
  last_checked_at?: string | null;
  last_seen_guid?: string | null;
  created_at: string;
}

export interface PlatformStat {
  platform: string;
  items: number;
  done: number;
  duration_s: number;
  tokens: number;
  cost_usd: number;
}

export interface Stats {
  total_items: number;
  items_by_status: Record<string, number>;
  items_by_platform: Record<string, number>;
  by_platform: PlatformStat[];
  avg_stage_ms: Record<string, number>;
  total_stage_ms: Record<string, number>;
  cost_by_stage: Record<string, number>;
  total_duration_s: number;
  transcript_words: number;
  transcript_chars: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  openrouter_requests: number;
  openrouter_tokens: number;
  gemini_tokens: number;
  total_cost_usd: number;
  http_429_total: number;
}

export interface AppSettings {
  llm_base_url: string;
  llm_model: string;
  stt_model: string;
  summary_map_model: string;
  llm_model_default: string;
  stt_model_default: string;
  summary_map_model_default: string;
  llm_model_options: string[];
  stt_model_options: string[];
  transcribe_chunk_seconds: number;
  transcribe_rate_limit: number;
  default_language: string;
  enable_gemini_audio_fallback: boolean;
  has_openrouter_key: boolean;
  has_llm_key: boolean;
}

export interface SettingsUpdate {
  llm_model: string;
  stt_model: string;
  summary_map_model: string;
}

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listItems: (params?: {
    status?: string;
    platform?: string;
    q?: string;
    favorite?: boolean;
    archived?: boolean;
    group_id?: number;
    ungrouped?: boolean;
    sort?: string;
    order?: string;
    limit?: number;
    offset?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params?.status) sp.set("status", params.status);
    if (params?.platform) sp.set("platform", params.platform);
    if (params?.q) sp.set("q", params.q);
    if (params?.favorite !== undefined) sp.set("favorite", String(params.favorite));
    if (params?.archived !== undefined) sp.set("archived", String(params.archived));
    if (params?.group_id !== undefined) sp.set("group_id", String(params.group_id));
    if (params?.ungrouped) sp.set("ungrouped", "true");
    if (params?.sort) sp.set("sort", params.sort);
    if (params?.order) sp.set("order", params.order);
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.offset !== undefined) sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return req<Item[]>(`/api/items${qs ? `?${qs}` : ""}`);
  },
  listGroups: () => req<Group[]>("/api/items/groups"),
  createGroup: (title: string) =>
    req<Group>("/api/items/groups", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  renameGroup: (id: number, title: string) =>
    req<Group>(`/api/items/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteGroup: (id: number) =>
    req<void>(`/api/items/groups/${id}`, { method: "DELETE" }),
  setItemGroup: (itemId: number, groupId: number | null) =>
    req<Item>(`/api/items/${itemId}/group`, {
      method: "POST",
      body: JSON.stringify({ group_id: groupId }),
    }),
  getItem: (id: number) => req<ItemDetail>(`/api/items/${id}`),
  addItems: (urls: string[]) =>
    req<Item[]>("/api/items", { method: "POST", body: JSON.stringify({ urls }) }),
  retryItem: (id: number) => req<Item>(`/api/items/${id}/retry`, { method: "POST" }),
  regenerateItem: (id: number) =>
    req<Item>(`/api/items/${id}/regenerate`, { method: "POST" }),
  deleteItem: (id: number) => req<void>(`/api/items/${id}`, { method: "DELETE" }),
  deleteMedia: (id: number) =>
    req<Item>(`/api/items/${id}/media`, { method: "DELETE" }),
  toggleFavorite: (id: number) =>
    req<Item>(`/api/items/${id}/favorite`, { method: "POST" }),
  toggleArchive: (id: number) =>
    req<Item>(`/api/items/${id}/archive`, { method: "POST" }),
  addComment: (id: number, body: string) =>
    req<Comment>(`/api/items/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  deleteComment: (itemId: number, commentId: number) =>
    req<void>(`/api/items/${itemId}/comments/${commentId}`, { method: "DELETE" }),

  listQueue: () => req<QueueItem[]>("/api/queue"),

  listSubscriptions: () => req<Subscription[]>("/api/subscriptions"),
  addSubscription: (feed_url: string, interval_minutes?: number) =>
    req<Subscription>("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ feed_url, interval_minutes }),
    }),
  toggleSubscription: (id: number) =>
    req<Subscription>(`/api/subscriptions/${id}/toggle`, { method: "POST" }),
  pollSubscription: (id: number) =>
    req<{ ok: boolean }>(`/api/subscriptions/${id}/poll`, { method: "POST" }),
  deleteSubscription: (id: number) =>
    req<void>(`/api/subscriptions/${id}`, { method: "DELETE" }),

  getStats: () => req<Stats>("/api/stats"),
  getSettings: () => req<AppSettings>("/api/settings"),
  updateSettings: (payload: SettingsUpdate) =>
    req<AppSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
};
