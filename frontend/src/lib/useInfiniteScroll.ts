import { useEffect, useRef } from "react";

/**
 * Watches a sentinel element and pulls the next page as it approaches the
 * viewport, replacing manual "Load more" buttons.
 *
 * The default viewport root works even though the scroll container is `main`
 * (`flex-1 overflow-auto`), because intersection is still computed against the
 * visible area.
 */
export function useInfiniteScroll({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  disabled = false,
  rootMargin = "800px 0px",
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  /** Collapsed sections pass `true` so they never prefetch in the background. */
  disabled?: boolean;
  rootMargin?: string;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Read through a ref so a new inline callback each render doesn't tear down
  // and recreate the observer.
  const fetchRef = useRef(fetchNextPage);
  fetchRef.current = fetchNextPage;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const inactive = disabled || !hasNextPage || isFetchingNextPage;
    if (!sentinel || inactive || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) fetchRef.current();
      },
      { rootMargin },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [disabled, hasNextPage, isFetchingNextPage, rootMargin]);

  return sentinelRef;
}

/** True when the browser cannot observe the sentinel and needs a real button. */
export const supportsInfiniteScroll = typeof IntersectionObserver !== "undefined";

/**
 * The error from a failed *next page* fetch, ignoring first-page errors (those
 * get a full-page ErrorState instead). Takes the fields structurally so callers
 * can pass a query object already narrowed by `isLoading`/`isError` checks.
 */
export function nextPageError(query: {
  isFetchNextPageError: boolean;
  error: Error | null;
}): Error | null {
  return query.isFetchNextPageError ? query.error : null;
}
