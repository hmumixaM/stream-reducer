/**
 * Sort vocabulary shared by the browse/library, channel item, and timeline
 * endpoints. Values are a whitelist: user input never reaches SQL directly.
 * The frontend mirrors these keys in `frontend/src/lib/sorts.ts`.
 */

export type SortColumns = Record<string, string>;

/** Item-level columns, addressed via the `item` table name. */
export const SORT_COLUMNS: SortColumns = {
  added: "item.created_at",
  published: "item.published_at",
  views: "item.view_count",
  likes: "item.like_count",
  duration: "item.duration_s",
  priority: "item.priority_score",
};

/** In a personal library, "added" is when the user saved it, and "position" is
 * the manual drag order within a folder. */
export const LIBRARY_SORT_COLUMNS: SortColumns = {
  ...SORT_COLUMNS,
  added: "ui.added_at",
  position: "ui.group_position",
};

/**
 * Channel and timeline lists alias `item` to `i` and can additionally sort by
 * when the feed surfaced the item.
 */
export const CHANNEL_SORT_COLUMNS: SortColumns = {
  added: "i.created_at",
  published: "i.published_at",
  views: "i.view_count",
  likes: "i.like_count",
  duration: "i.duration_s",
  priority: "i.priority_score",
  discovered: "discovered_at",
};

/** Resolves a requested sort key to a column, falling back to the default. */
export function sortColumn(
  columns: SortColumns,
  requested: string | undefined,
  fallback: string,
): string {
  return columns[requested ?? ""] ?? columns[fallback] ?? fallback;
}

export function sortOrder(requested: string | undefined): "ASC" | "DESC" {
  return requested === "asc" ? "ASC" : "DESC";
}
