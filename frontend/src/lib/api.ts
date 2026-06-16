import { MIRROR } from "@/lib/mirror";

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
  headline?: string | null;
  subhead?: string | null;
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
  // Multi-user extensions (Cloudflare backend):
  saved?: boolean;
  personal_status?: "waiting" | "done" | null;
  request_count?: number;
  interest_count?: number;
  is_interested?: boolean;
  priority_score?: number;
}

export interface User {
  id: number;
  email: string;
  is_admin: boolean;
  created_at: string;
}

export interface AdminUser {
  id: number;
  email: string;
  is_admin: boolean;
  created_at: string;
  library_count: number;
  queued_count: number;
  subscription_count: number;
}

export interface AdminQueueItem extends Item {
  owners: string[];
  owner_count: number;
  queue_position: number;
}

export interface QueueItem extends Item {
  current_stage?: string | null;
  chunk_done: number;
  chunk_count: number;
  queue_position?: number;
  queue_total?: number;
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

export type HighlightSource = "summary" | "transcript";

export interface Highlight {
  id: number;
  item_id: number;
  source: HighlightSource;
  quote: string;
  note: string;
  color: string;
  prefix: string;
  suffix: string;
  created_at: string;
}

export interface NewHighlight {
  quote: string;
  source: HighlightSource;
  note?: string;
  color?: string;
  prefix?: string;
  suffix?: string;
}

export interface ItemBrief {
  id: number;
  title?: string | null;
  platform: Platform;
  source_url: string;
  author?: string | null;
  thumbnail?: string | null;
}

export interface Annotation {
  kind: "highlight" | "comment";
  id: number;
  item: ItemBrief;
  created_at: string;
  quote?: string | null;
  source?: HighlightSource | null;
  color?: string | null;
  body: string;
}

export type TranslationStatus = "queued" | "processing" | "done" | "error";

export interface TranslationRef {
  lang: string;
  status: TranslationStatus;
}

export interface Translation {
  lang: string;
  status: TranslationStatus;
  model?: string;
  markdown: string;
  structured: Record<string, unknown>;
  error?: string | null;
  updated_at?: string;
}

// Supported on-demand translation languages (kept in sync with the worker).
export const TRANSLATE_LANGS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "zh", label: "简体中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "ru", label: "Русский" },
];

export interface ItemDetail extends Item {
  summary?: Summary | null;
  transcript?: Transcript | null;
  stages: StageRun[];
  comments: Comment[];
  highlights: Highlight[];
  translations?: TranslationRef[];
  // Only present in the static mirror bundle (related articles embedded so the
  // recommendation grid works without a live API).
  related?: RelatedItem[];
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
  window_days: number;
  min_published_at?: string | null;
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

export interface SearchHit {
  chunk_id: number;
  item_id: number;
  title?: string | null;
  source_url: string;
  platform: Platform;
  author?: string | null;
  source: "transcript" | "summary";
  field: string;
  text: string;
  start_s?: number | null;
  end_s?: number | null;
  deep_link?: string | null;
  score: number;
}

// A node is a single summary paragraph; edges link paragraphs by embedding
// similarity. Communities only color the nodes.
export interface GraphNode {
  id: number; // chunk_id
  item_id: number;
  title?: string | null;
  platform: Platform;
  field: string;
  text: string;
  community: number;
  degree: number;
}

export interface GraphEdge {
  source: number;
  target: number;
  weight: number;
}

export interface GraphData {
  build_id: number;
  built_at: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RelatedItem {
  id: number;
  item_id: number;
  title?: string | null;
  platform: Platform;
  author?: string | null;
  thumbnail?: string | null;
  source_url: string;
  score: number;
}

export interface GraphFilters {
  archived?: boolean;
  favorite?: boolean;
  folders?: number[];
  platform?: string;
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
    credentials: "include",
    ...options,
  });
  if (res.status === 401) {
    // Session missing/expired: bounce to login (unless already there).
    if (!location.pathname.startsWith("/login")) {
      location.href = "/login";
    }
    throw new Error("401: unauthorized");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function optionalSession(): Promise<{ user: User | null }> {
  const res = await fetch("/api/auth/me", {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (res.status === 401) return { user: null };
  if (!res.ok) return { user: null };
  return res.json() as Promise<{ user: User | null }>;
}

export interface ListItemsParams {
  status?: string;
  platform?: string;
  q?: string;
  favorite?: boolean;
  archived?: boolean;
  group_id?: number;
  subscription_id?: number;
  ungrouped?: boolean;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

export interface SearchParams {
  q: string;
  k?: number;
  source?: string;
  item_id?: number;
  // "library" (default) searches the user's saved items; "global" searches the
  // whole catalog.
  scope?: "library" | "global";
}

// --- Mirror (static) backend ---------------------------------------------
// In mirror mode the read endpoints are served from pre-exported JSON under
// `/data` (see `mirror/export.py`); there is no live API. Each dataset is
// fetched once and cached for the lifetime of the page.

type SearchDoc = SearchHit & { id: number };

const mirrorJson = (() => {
  const cache = new Map<string, Promise<unknown>>();
  return <T,>(path: string): Promise<T> => {
    if (!cache.has(path)) {
      cache.set(
        path,
        fetch(path).then((r) => {
          if (!r.ok) throw new Error(`${r.status}: ${path}`);
          return r.json();
        }),
      );
    }
    return cache.get(path) as Promise<T>;
  };
})();

// Fetch a gzipped JSON asset and inflate it in the browser. Used for the search
// index, whose raw JSON outgrows Cloudflare Pages' 25 MiB per-file limit; the
// gzipped file stays well under it. `DecompressionStream` is supported in all
// current evergreen browsers (Chrome 80+, Firefox 113+, Safari 16.4+).
async function fetchGzipJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok || !res.body) throw new Error(`${res.status}: ${path}`);
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text) as T;
}

let mirrorSearchIndex: Promise<{
  search: (q: string) => Array<Record<string, unknown>>;
}> | null = null;

function loadMirrorSearchIndex() {
  if (!mirrorSearchIndex) {
    mirrorSearchIndex = (async () => {
      const { default: MiniSearch } = await import("minisearch");
      const docs = await fetchGzipJson<SearchDoc[]>("/data/search-index.json.gz");
      const ms = new MiniSearch<SearchDoc>({
        idField: "id",
        fields: ["text", "title"],
        storeFields: [
          "chunk_id",
          "item_id",
          "title",
          "source_url",
          "platform",
          "author",
          "source",
          "field",
          "text",
          "start_s",
          "end_s",
          "deep_link",
        ],
        searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.2 },
      });
      ms.addAll(docs);
      return ms;
    })();
  }
  return mirrorSearchIndex;
}

async function mirrorSearch(params: SearchParams): Promise<SearchHit[]> {
  const ms = await loadMirrorSearchIndex();
  let results = ms.search(params.q);
  if (params.source) results = results.filter((r) => r.source === params.source);
  if (params.item_id !== undefined)
    results = results.filter((r) => r.item_id === params.item_id);
  const k = params.k ?? 10;
  return results.slice(0, k).map(
    (r): SearchHit => ({
      chunk_id: r.chunk_id as number,
      item_id: r.item_id as number,
      title: (r.title as string | null) ?? null,
      source_url: r.source_url as string,
      platform: r.platform as Platform,
      author: (r.author as string | null) ?? null,
      source: r.source as "transcript" | "summary",
      field: r.field as string,
      text: r.text as string,
      start_s: (r.start_s as number | null) ?? null,
      end_s: (r.end_s as number | null) ?? null,
      deep_link: (r.deep_link as string | null) ?? null,
      score: r.score as number,
    }),
  );
}

// In mirror mode the graph is unified (filters are ignored), read straight from
// the pre-exported JSON with no live API.
async function mirrorGraph(): Promise<GraphData> {
  return mirrorJson<GraphData>("/data/graph.json");
}

async function mirrorRelated(itemId: number): Promise<RelatedItem[]> {
  const detail = await mirrorJson<ItemDetail>(`/data/items/${itemId}.json`);
  return detail.related ?? [];
}

function graphFilterParams(filters?: GraphFilters): string {
  const sp = new URLSearchParams();
  if (filters?.archived) sp.set("archived", "true");
  if (filters?.favorite) sp.set("favorite", "true");
  if (filters?.folders?.length) sp.set("folders", filters.folders.join(","));
  if (filters?.platform) sp.set("platform", filters.platform);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

function itemQuery(params?: ListItemsParams): string {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.platform) sp.set("platform", params.platform);
  if (params?.q) sp.set("q", params.q);
  if (params?.favorite !== undefined) sp.set("favorite", String(params.favorite));
  if (params?.archived !== undefined) sp.set("archived", String(params.archived));
  if (params?.group_id !== undefined) sp.set("group_id", String(params.group_id));
  if (params?.subscription_id !== undefined) sp.set("subscription_id", String(params.subscription_id));
  if (params?.ungrouped) sp.set("ungrouped", "true");
  if (params?.sort) sp.set("sort", params.sort);
  if (params?.order) sp.set("order", params.order);
  if (params?.limit !== undefined) sp.set("limit", String(params.limit));
  if (params?.offset !== undefined) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  // --- auth ---
  requestMagicLink: (email: string) =>
    req<{ ok: boolean }>("/api/auth/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  getMe: () => optionalSession(),
  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  // The signed-in user's personal library (waiting + done).
  listItems: (params?: ListItemsParams) => req<Item[]>(`/api/items/library${itemQuery(params)}`),
  // The global catalog everyone has ingested (Browse page).
  browseItems: (params?: ListItemsParams) => req<Item[]>(`/api/items${itemQuery(params)}`),
  listGroups: (archived?: boolean) =>
    MIRROR
      ? mirrorJson<Group[]>("/data/groups.json")
      : req<Group[]>(
          `/api/items/groups${archived !== undefined ? `?archived=${archived}` : ""}`,
        ),
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
  getItem: (id: number) =>
    MIRROR
      ? mirrorJson<ItemDetail>(`/data/items/${id}.json`)
      : req<ItemDetail>(`/api/items/${id}`),
  // Add URLs to the signed-in user's library (dedup + enqueue server-side).
  addItems: (urls: string[]) =>
    req<Item[]>("/api/items/library", { method: "POST", body: JSON.stringify({ urls }) }),
  retryItem: (id: number) => req<Item>(`/api/items/${id}/retry`, { method: "POST" }),
  regenerateItem: (id: number) =>
    req<Item>(`/api/items/${id}/regenerate`, { method: "POST" }),
  deleteItem: (id: number) => req<void>(`/api/items/${id}`, { method: "DELETE" }),
  deleteMedia: (id: number) =>
    req<Item>(`/api/items/${id}/media`, { method: "DELETE" }),
  toggleInterest: (id: number) =>
    req<Item>(`/api/items/${id}/interest`, { method: "POST" }),
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

  addHighlight: (id: number, payload: NewHighlight) =>
    req<Highlight>(`/api/items/${id}/highlights`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateHighlight: (
    itemId: number,
    highlightId: number,
    payload: { note?: string; color?: string },
  ) =>
    req<Highlight>(`/api/items/${itemId}/highlights/${highlightId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteHighlight: (itemId: number, highlightId: number) =>
    req<void>(`/api/items/${itemId}/highlights/${highlightId}`, {
      method: "DELETE",
    }),
  listAnnotations: (params?: { kind?: "highlight" | "comment"; item_id?: number }) => {
    const sp = new URLSearchParams();
    if (params?.kind) sp.set("kind", params.kind);
    if (params?.item_id !== undefined) sp.set("item_id", String(params.item_id));
    const qs = sp.toString();
    return req<Annotation[]>(`/api/annotations${qs ? `?${qs}` : ""}`);
  },

  listQueue: () => req<QueueItem[]>("/api/queue"),

  listSubscriptions: () => req<Subscription[]>("/api/subscriptions"),
  addSubscription: (feed_url: string, interval_minutes?: number, window_days?: number) =>
    req<Subscription>("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ feed_url, interval_minutes, window_days }),
    }),
  toggleSubscription: (id: number) =>
    req<Subscription>(`/api/subscriptions/${id}/toggle`, { method: "POST" }),
  pollSubscription: (id: number) =>
    req<{ ok: boolean }>(`/api/subscriptions/${id}/poll`, { method: "POST" }),
  listSubscriptionItems: (id: number) =>
    req<Item[]>(`/api/subscriptions/${id}/items`),
  addSubscriptionComment: (id: number, body: string) =>
    req<Record<string, unknown>>(`/api/subscriptions/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  addSubscriptionHighlight: (id: number, quote: string, note = "") =>
    req<Record<string, unknown>>(`/api/subscriptions/${id}/highlights`, {
      method: "POST",
      body: JSON.stringify({ quote, note }),
    }),
  listSubscriptionAnnotations: (id: number) =>
    req<Record<string, unknown>[]>(`/api/subscriptions/${id}/annotations`),
  deleteSubscription: (id: number) =>
    req<void>(`/api/subscriptions/${id}`, { method: "DELETE" }),

  search: (params: SearchParams) => {
    if (MIRROR) return mirrorSearch(params);
    const sp = new URLSearchParams();
    sp.set("q", params.q);
    if (params.k !== undefined) sp.set("k", String(params.k));
    if (params.source) sp.set("source", params.source);
    if (params.item_id !== undefined) sp.set("item_id", String(params.item_id));
    if (params.scope) sp.set("scope", params.scope);
    return req<SearchHit[]>(`/api/search?${sp.toString()}`);
  },

  getGraph: (filters?: GraphFilters) =>
    MIRROR
      ? mirrorGraph()
      : req<GraphData>(`/api/graph${graphFilterParams(filters)}`),
  getTranslation: (id: number, lang: string) =>
    req<Translation>(`/api/items/${id}/translation?lang=${encodeURIComponent(lang)}`),
  requestTranslation: (id: number, lang: string) =>
    req<TranslationRef>(`/api/items/${id}/translate`, {
      method: "POST",
      body: JSON.stringify({ lang }),
    }),
  getRelated: (id: number) =>
    MIRROR ? mirrorRelated(id) : req<RelatedItem[]>(`/api/items/${id}/related`),
  getItemFocus: async (id: number): Promise<number | null> => {
    if (MIRROR) {
      const graph = await mirrorGraph();
      const node = graph.nodes.find((n) => n.item_id === id);
      return node ? node.id : null;
    }
    const res = await req<{ node_id: number | null }>(
      `/api/graph/items/${id}/focus`,
    );
    return res.node_id;
  },
  rebuildGraph: () =>
    req<{ ok: boolean; job_id: string }>("/api/graph/rebuild", { method: "POST" }),

  getStats: (refresh?: boolean) =>
    req<Stats>(`/api/stats${refresh ? "?refresh=true" : ""}`),
  // --- admin ---
  adminListUsers: () => req<AdminUser[]>("/api/admin/users"),
  adminSetUserAdmin: (id: number, is_admin: boolean) =>
    req<{ ok: boolean }>(`/api/admin/users/${id}/admin`, {
      method: "POST",
      body: JSON.stringify({ is_admin }),
    }),
  adminDeleteUser: (id: number) =>
    req<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  adminQueue: () => req<AdminQueueItem[]>("/api/admin/queue"),
  adminBumpQueue: (id: number) =>
    req<{ ok: boolean }>(`/api/admin/queue/${id}/bump`, { method: "POST" }),
  adminRetryQueue: (id: number) =>
    req<{ ok: boolean }>(`/api/admin/queue/${id}/retry`, { method: "POST" }),
  adminDeleteQueue: (id: number) =>
    req<{ ok: boolean }>(`/api/admin/queue/${id}`, { method: "DELETE" }),

  getSettings: () => req<AppSettings>("/api/settings"),
  updateSettings: (payload: SettingsUpdate) =>
    req<AppSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
};
