import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rss } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Platform, type TimelineItem } from "@/lib/api";
import { Button, Select } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  FilterChip,
  InfiniteScrollSentinel,
  ItemGrid,
  PageHeader,
  SkeletonGrid,
  Toolbar,
} from "@/components/shell";
import { CatalogItemCard } from "@/components/CatalogItemCard";
import { ChannelFilterStrip } from "@/components/ChannelFilterStrip";
import { ItemCard, type ItemCardActions } from "@/components/ItemCard";
import { TIMELINE_SORTS } from "@/lib/sorts";
import { nextPageError } from "@/lib/useInfiniteScroll";

const PAGE_SIZE = 30;
/** The API caps a channel page at 50, which is also as many avatars as a strip can carry. */
const MAX_STRIP_CHANNELS = 50;
const PLATFORMS: { value: Platform; label: string }[] = [
  { value: "youtube", label: "YouTube" },
  { value: "bilibili", label: "Bilibili" },
  { value: "apple_podcast", label: "Apple Podcasts" },
  { value: "xiaoyuzhou", label: "小宇宙" },
  { value: "rss", label: "RSS" },
];
type Focus = "all" | "unsaved" | "ready";
const FOCUS_LABELS: Record<Focus, string> = {
  all: "All",
  unsaved: "Not saved",
  ready: "Ready to read",
};

export function Timeline() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = searchParams.get("sort") ?? "published";
  const platform = (searchParams.get("platform") ?? "") as Platform | "";
  const focus = (searchParams.get("focus") ?? "all") as Focus;
  const channelId = Number(searchParams.get("channel")) || null;
  const queryClient = useQueryClient();

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    setSearchParams(params, { replace: true });
  };

  const timeline = useInfiniteQuery({
    queryKey: ["timeline", { sort, platform, focus, channelId }],
    queryFn: ({ pageParam }) =>
      api.listTimeline({
        sort,
        channelId: channelId ?? undefined,
        platform: platform || undefined,
        saved: focus === "unsaved" ? false : undefined,
        ready: focus === "ready" ? true : undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    refetchInterval: 30000,
  });
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api.listGroups() });
  // Own key: the Following tab pages the same endpoint under ["channels", "following"].
  const follows = useQuery({
    queryKey: ["channels", "following", "strip"],
    queryFn: () => api.listChannels({ following: true, limit: MAX_STRIP_CHANNELS }),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["timeline"] });
    queryClient.invalidateQueries({ queryKey: ["items"] });
    queryClient.invalidateQueries({ queryKey: ["groups"] });
  };
  const favorite = useMutation({ mutationFn: api.toggleFavorite, onSuccess: invalidate });
  const archive = useMutation({ mutationFn: api.toggleArchive, onSuccess: invalidate });
  const move = useMutation({
    mutationFn: ({ itemId, groupId }: { itemId: number; groupId: number | null }) =>
      api.setItemGroup(itemId, groupId),
    onSuccess: invalidate,
  });
  const createAndMove = useMutation({
    mutationFn: async ({ itemId, title }: { itemId: number; title: string }) => {
      const group = await api.createGroup(title);
      return api.setItemGroup(itemId, group.id);
    },
    onSuccess: invalidate,
  });
  const addToLibrary = useMutation({
    mutationFn: (item: TimelineItem) => api.addItems([item.source_url]),
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["queue"] });
      queryClient.invalidateQueries({ queryKey: ["browse"] });
    },
  });

  const actions: ItemCardActions = {
    onFavorite: favorite.mutate,
    onArchive: archive.mutate,
    groups: groups.data ?? [],
    onMove: (itemId, groupId) => move.mutate({ itemId, groupId }),
    onCreateFolderAndMove: (itemId, title) => createAndMove.mutate({ itemId, title }),
  };

  const rows = timeline.data?.pages.flat() ?? [];
  const filtering = Boolean(platform) || focus !== "all" || channelId !== null;
  const channels = follows.data ?? [];
  const hasFollows = channels.length > 0;
  const activeChannel = channels.find((channel) => channel.id === channelId) ?? null;

  const renderCard = (item: TimelineItem) => {
    const channel = { id: item.channel_id, title: item.channel_title };
    return item.in_library ? (
      <ItemCard key={item.id} item={item} channel={channel} {...actions} />
    ) : (
      <CatalogItemCard
        key={item.id}
        item={item}
        channel={channel}
        adding={addToLibrary.isPending && addToLibrary.variables?.id === item.id}
        onAdd={() => addToLibrary.mutate(item)}
      />
    );
  };

  return (
    <div>
      <PageHeader
        title="Timeline"
        subtitle={
          activeChannel
            ? `Everything ${activeChannel.title || activeChannel.feed_url} has published.`
            : "The newest episodes from every channel you follow. Add the ones you want processed."
        }
        actions={
          activeChannel && (
            <Link to={`/channels/${activeChannel.id}`}>
              <Button size="sm" variant="outline">
                Channel page
              </Button>
            </Link>
          )
        }
      />

      <ChannelFilterStrip
        channels={channels}
        activeId={channelId}
        onSelect={(id) => setParam("channel", id === null ? "" : String(id))}
      />

      <Toolbar>
        <Select
          value={sort}
          className="w-auto min-w-[150px]"
          title="Sort by"
          onChange={(event) => setParam("sort", event.target.value)}
        >
          {TIMELINE_SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Select
          value={platform}
          className="w-auto min-w-[140px]"
          title="Platform"
          onChange={(event) => setParam("platform", event.target.value)}
        >
          <option value="">All platforms</option>
          {PLATFORMS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {(Object.keys(FOCUS_LABELS) as Focus[]).map((value) => (
            <FilterChip
              key={value}
              label={FOCUS_LABELS[value]}
              active={focus === value}
              onClick={() => setParam("focus", value === "all" ? "" : value)}
            />
          ))}
        </div>
      </Toolbar>

      {timeline.isLoading ? (
        <SkeletonGrid count={8} />
      ) : timeline.isError ? (
        <ErrorState
          message={`Your timeline could not be loaded: ${timeline.error.message}`}
          onRetry={() => timeline.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyTimeline filtering={filtering} hasFollows={hasFollows} />
      ) : (
        <>
          {/* Date grouping only makes sense chronologically; other sorts get a flat grid. */}
          {sort === "published" ? (
            <div className="space-y-8">
              {groupByDay(rows).map(({ label, items }) => (
                <section key={label}>
                  <h2 className="sticky top-0 z-10 -mx-1 mb-3 bg-background/90 px-1 py-2 text-sm font-semibold backdrop-blur md:top-0">
                    {label}
                    <span className="ml-2 font-normal text-muted-foreground">{items.length}</span>
                  </h2>
                  <ItemGrid>{items.map(renderCard)}</ItemGrid>
                </section>
              ))}
            </div>
          ) : (
            <ItemGrid>{rows.map(renderCard)}</ItemGrid>
          )}
          {addToLibrary.isError && (
            <p className="mt-3 text-sm text-danger" role="alert">
              Could not add that episode: {addToLibrary.error.message}
            </p>
          )}
          <InfiniteScrollSentinel
            hasNextPage={!!timeline.hasNextPage}
            isFetchingNextPage={timeline.isFetchingNextPage}
            fetchNextPage={() => timeline.fetchNextPage()}
            error={nextPageError(timeline)}
            totalLabel={`${rows.length} episode${rows.length === 1 ? "" : "s"} from your channels`}
          />
        </>
      )}
    </div>
  );
}

function EmptyTimeline({
  filtering,
  hasFollows,
}: {
  filtering: boolean;
  hasFollows: boolean;
}) {
  if (filtering) {
    return (
      <EmptyState
        icon={<Rss className="h-5 w-5" />}
        title="Nothing matches these filters"
        description="Clear a filter or switch back to All to see the rest of your timeline."
      />
    );
  }
  if (!hasFollows) {
    return (
      <EmptyState
        icon={<Rss className="h-5 w-5" />}
        title="Follow a channel to build your timeline"
        description="Once you follow channels, their new episodes collect here so you can pick what to process."
        action={
          <Link to="/subscriptions?tab=discover">
            <Button size="sm">Discover channels</Button>
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<Rss className="h-5 w-5" />}
      title="No episodes yet"
      description="Your channels have not surfaced anything yet. New items appear here as they are discovered."
      action={
        <Link to="/subscriptions?tab=following">
          <Button size="sm" variant="outline">
            Check your follows
          </Button>
        </Link>
      }
    />
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Buckets a published-desc page into Today / Yesterday / This week / month labels. */
function groupByDay(items: TimelineItem[]): { label: string; items: TimelineItem[] }[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const groups: { label: string; items: TimelineItem[] }[] = [];

  for (const item of items) {
    const label = dayLabel(item.published_at, startOfToday.getTime());
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function dayLabel(published: string | null | undefined, todayStart: number): string {
  if (!published) return "No publish date";
  const time = new Date(published).getTime();
  if (Number.isNaN(time)) return "No publish date";
  if (time >= todayStart) return "Today";
  if (time >= todayStart - DAY_MS) return "Yesterday";
  if (time >= todayStart - 7 * DAY_MS) return "Earlier this week";
  return new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "long" });
}
