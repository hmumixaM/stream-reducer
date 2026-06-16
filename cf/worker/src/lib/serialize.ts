import type { ItemRow, UserItemRow } from "../db";

// Shape a global item row (+ optional per-user state) into the JSON the SPA's
// `Item` type expects. Per-user fields fall back to neutral defaults when the
// user hasn't saved the item (i.e. when browsing the global catalog).
export function toItemRead(
  item: ItemRow,
  ui?: UserItemRow | null,
  extra?: { is_interested?: boolean },
) {
  return {
    id: item.id,
    platform: item.platform,
    source_url: item.source_url,
    external_id: item.external_id,
    title: item.title,
    headline: item.headline,
    subhead: item.subhead,
    author: item.author,
    description: item.description,
    duration_s: item.duration_s,
    published_at: item.published_at,
    thumbnail: item.thumbnail,
    view_count: item.view_count,
    like_count: item.like_count,
    dislike_count: item.dislike_count,
    status: item.status,
    error: item.error,
    subscription_id: ui?.subscription_id ?? null,
    group_id: ui?.folder_id ?? null,
    group_position: ui?.group_position ?? null,
    is_favorite: !!(ui?.is_favorite ?? 0),
    is_archived: !!(ui?.is_archived ?? 0),
    media_bytes: item.media_bytes,
    audio_duration_s: item.audio_duration_s,
    media_path: item.media_key,
    enqueued_at: item.enqueued_at,
    started_at: item.started_at,
    completed_at: item.completed_at,
    total_processing_ms: item.total_processing_ms,
    total_api_requests: item.total_api_requests,
    total_tokens: item.total_tokens,
    total_cost_usd: item.total_cost_usd,
    retry_count: item.retry_count,
    created_at: item.created_at,
    // Multi-user extensions:
    saved: !!ui,
    personal_status: ui?.personal_status ?? null,
    request_count: item.request_count,
    interest_count: item.interest_count,
    is_interested: !!extra?.is_interested,
    priority_score: item.priority_score,
  };
}
