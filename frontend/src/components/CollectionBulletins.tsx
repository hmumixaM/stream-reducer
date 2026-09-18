import { useInfiniteQuery } from "@tanstack/react-query";
import { api, type BulletinCardItem } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { dateLabel } from "@/lib/bulletin";
import { nextPageError } from "@/lib/useInfiniteScroll";
import { BulletinCard } from "./BulletinCard";
import { EmptyState, ErrorState, InfiniteScrollSentinel } from "./shell";

export function CollectionBulletins({ slug, section, trackId }: { slug: string; section: string; trackId: string }) {
  const me = useMe();
  const zh = me.data?.user?.preferred_language === "zh";
  const feed = useInfiniteQuery({
    queryKey: ["collection-bulletin", slug, section, trackId, me.data?.user?.id, zh],
    queryFn: ({ pageParam }) => api.listCollectionBulletins(slug, { section, track_id: trackId, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: (query) => query.state.data?.pages.some((page) => page.items.some((item) => item.localization_status === "queued" || item.localization_status === "processing")) ? 30_000 : false,
  });
  const items = [...new Map((feed.data?.pages.flatMap((page) => page.items) || []).map((item) => [item.id, item])).values()];
  const groups = new Map<string, BulletinCardItem[]>();
  for (const item of items) {
    const date = dateLabel(item.published_at || item.created_at, zh);
    groups.set(date, [...(groups.get(date) || []), item]);
  }
  const context = new URLSearchParams({ collection: slug });
  if (section) context.set("section", section);
  if (trackId) context.set("track_id", trackId);
  if (feed.isLoading) return <div aria-label={zh ? "加载简报" : "Loading bulletins"} className="space-y-5">{[0, 1, 2].map((key) => <div key={key} className="h-56 animate-pulse rounded-xl bg-muted/40" />)}</div>;
  if (feed.isError && !items.length) return <ErrorState message={zh ? "简报加载失败，请重试。" : "Bulletins could not be loaded."} onRetry={() => feed.refetch()} />;
  if (!items.length) return <EmptyState title={zh ? "这个专题还没有简报" : "No bulletins in this selection yet"} description={zh ? "换一个分类或专题，或者在视频目录查看处理进度。" : "Choose another category or track, or check the video directory for processing progress."} />;
  return <>
    {[...groups].map(([date, entries]) => <section key={date} className="desk-day">
      <div className="desk-day-label"><span>{date}</span><span className="text-muted-foreground/60">{entries.length} {zh ? "篇" : "stories"}</span></div>
      <div className="desk-timeline">{entries.map((item) => <BulletinCard key={item.id} item={item} zh={zh} showOverview href={me.data?.user ? `/bulletin/${item.id}?${context}` : `/items/${item.id}`} />)}</div>
    </section>)}
    <InfiniteScrollSentinel variant="rows" hasNextPage={Boolean(feed.hasNextPage)} isFetchingNextPage={feed.isFetchingNextPage} disabled={feed.isFetching} fetchNextPage={() => feed.fetchNextPage({ cancelRefetch: false })} error={nextPageError(feed)} totalLabel={zh ? `已展示 ${items.length} 篇简报` : `${items.length} bulletins`} />
  </>;
}
