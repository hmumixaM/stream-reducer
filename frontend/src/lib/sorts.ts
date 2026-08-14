export interface SortOption {
  value: string;
  label: string;
}

/** Sort vocabulary shared by Library, Timeline, and channel item lists. The
 * values mirror the worker's whitelist in `cf/worker/src/lib/sort.ts`. */
export const ITEM_SORTS: SortOption[] = [
  { value: "added", label: "Recently added" },
  { value: "published", label: "Publish date" },
  { value: "views", label: "Most views" },
  { value: "likes", label: "Most likes" },
  { value: "duration", label: "Longest" },
];

/** Channel and timeline lists add "when this feed surfaced it", which the
 * library has no equivalent for. */
export const DISCOVERED_SORT: SortOption = {
  value: "discovered",
  label: "Recently discovered",
};

export const CHANNEL_ITEM_SORTS: SortOption[] = [DISCOVERED_SORT, ...ITEM_SORTS];

export const TIMELINE_SORTS: SortOption[] = [
  { value: "published", label: "Publish date" },
  DISCOVERED_SORT,
  { value: "added", label: "Recently added" },
  { value: "views", label: "Most views" },
  { value: "likes", label: "Most likes" },
  { value: "duration", label: "Longest" },
];
