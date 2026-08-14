import { useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Compass, Link2, Rss, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { ChannelCard } from "@/components/ChannelCard";
import { ChannelRow } from "@/components/ChannelRow";
import { ChannelTile } from "@/components/ChannelTile";
import { Button, Card, Input, Select, Spinner } from "@/components/ui";
import {
  ChipRow,
  EmptyState,
  ErrorState,
  FilterChip,
  InfiniteScrollSentinel,
  ItemGrid,
  LoadingState,
  PageHeader,
  SectionHeader,
  SkeletonGrid,
  Toolbar,
} from "@/components/shell";
import { nextPageError } from "@/lib/useInfiniteScroll";
import {
  api,
  type ChannelFollowRead,
  type ChannelRead,
  type Group,
  type Platform,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 24;
// Follows change only when a poll lands, so a slow baseline is plenty; a poll in
// flight temporarily tightens it (see FollowingChannels).
const FOLLOW_REFETCH_MS = 15000;
const FOLLOW_REFETCH_ACTIVE_MS = 3000;
const PLATFORMS: { value: Platform; label: string }[] = [
  { value: "youtube", label: "YouTube" },
  { value: "bilibili", label: "Bilibili" },
  { value: "apple_podcast", label: "Apple Podcasts" },
  { value: "xiaoyuzhou", label: "小宇宙" },
  { value: "rss", label: "RSS / podcast" },
  { value: "unknown", label: "Other" },
];

export function Subscriptions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab = requestedTab === "following" ? "following" : "discover";
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api.listGroups() });

  useEffect(() => {
    if (requestedTab === "discover" || requestedTab === "following") return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", "discover");
    setSearchParams(params, { replace: true });
  }, [requestedTab, searchParams, setSearchParams]);

  const setTab = (next: "discover" | "following") => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params);
  };

  return (
    <div>
      <PageHeader
        title="Channels"
        subtitle="Discover known channels, follow the ones you care about, and optionally receive new items automatically."
      />

      <nav className="mb-6 flex border-b border-border" aria-label="Channel views">
        <TabLink
          active={tab === "discover"}
          icon={<Compass className="h-4 w-4" />}
          onClick={() => setTab("discover")}
        >
          Discover
        </TabLink>
        <TabLink
          active={tab === "following"}
          icon={<Rss className="h-4 w-4" />}
          onClick={() => setTab("following")}
        >
          Following
        </TabLink>
      </nav>

      {tab === "discover" ? (
        <DiscoverChannels groups={groups.data ?? []} />
      ) : (
        <FollowingChannels
          groups={groups.data ?? []}
          onDiscover={() => setTab("discover")}
        />
      )}
    </div>
  );
}

function DiscoverChannels({ groups }: { groups: Group[] }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [addOpen, setAddOpen] = useState(false);
  const [preview, setPreview] = useState<ChannelRead | null>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), 300);

  const channels = useInfiniteQuery({
    queryKey: ["channels", "catalog", { q: debouncedQuery, platform }],
    queryFn: ({ pageParam }) =>
      api.listChannels({
        q: debouncedQuery || undefined,
        platform: platform || undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
  });
  const rows = channels.data?.pages.flat() ?? [];
  const filtering = Boolean(debouncedQuery || platform);

  const updatePreviewFollow = (follow: ChannelFollowRead | null) => {
    setPreview((channel) => (channel ? { ...channel, follow } : channel));
  };

  return (
    <div className="space-y-6">
      <Toolbar className="mb-0">
        <label className="relative min-w-[200px] flex-1">
          <span className="sr-only">Search channel names</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            name="q"
            value={query}
            maxLength={100}
            placeholder="Search known channels"
            className="pl-9"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Select
          name="platform"
          className="w-auto min-w-[160px]"
          title="Platform"
          value={platform}
          onChange={(event) => setPlatform(event.target.value as Platform | "")}
        >
          <option value="">All platforms</option>
          {PLATFORMS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Button variant="outline" onClick={() => setAddOpen(true)}>
          <Link2 className="h-4 w-4" /> Add by URL
        </Button>
      </Toolbar>

      {addOpen && (
        <AddChannelDialog
          onClose={() => setAddOpen(false)}
          onResolved={(channel) => {
            setPreview(channel);
            setAddOpen(false);
            queryClient.invalidateQueries({ queryKey: ["channels", "catalog"] });
          }}
        />
      )}

      {preview && (
        <section aria-labelledby="channel-preview-title">
          <SectionHeader
            id="channel-preview-title"
            title="Channel preview"
            subtitle="Resolved from the URL you pasted."
            actions={
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Dismiss
              </Button>
            }
          />
          <ChannelCard
            channel={preview}
            groups={groups}
            onFollowChanged={updatePreviewFollow}
          />
        </section>
      )}

      <section aria-labelledby="known-channels-title">
        <SectionHeader id="known-channels-title" title="Known channels" />
        {channels.isLoading ? (
          <SkeletonGrid count={8} />
        ) : channels.isError ? (
          <ErrorState
            message={`Channels could not be loaded: ${channels.error.message}`}
            onRetry={() => channels.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Compass className="h-5 w-5" />}
            title={filtering ? "No matching channels" : "No known channels yet"}
            description={
              filtering
                ? "Try another name or platform."
                : "Paste a channel or feed URL to add the first one to the catalog."
            }
            action={
              !filtering && (
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Link2 className="h-4 w-4" /> Add by URL
                </Button>
              )
            }
          />
        ) : (
          <>
            <ItemGrid>
              {rows.map((channel) => (
                <ChannelTile key={channel.id} channel={channel} groups={groups} />
              ))}
            </ItemGrid>
            <InfiniteScrollSentinel
              hasNextPage={!!channels.hasNextPage}
              isFetchingNextPage={channels.isFetchingNextPage}
              fetchNextPage={() => channels.fetchNextPage()}
              error={nextPageError(channels)}
              totalLabel={`${rows.length} channel${rows.length === 1 ? "" : "s"}`}
            />
          </>
        )}
      </section>
    </div>
  );
}

function AddChannelDialog({
  onClose,
  onResolved,
}: {
  onClose: () => void;
  onResolved: (channel: ChannelRead) => void;
}) {
  const [channelUrl, setChannelUrl] = useState("");
  const resolve = useMutation({
    mutationFn: () => api.resolveChannel(channelUrl.trim()),
    onSuccess: onResolved,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-24 animate-fade-in"
      onClick={onClose}
    >
      <Card className="w-full max-w-lg p-5" onClick={(event) => event.stopPropagation()}>
        <h2 className="mb-1 text-lg font-semibold">Add a channel by URL</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Paste a YouTube channel, Bilibili space, Apple Podcasts show, 小宇宙 podcast,
          or any RSS feed. We resolve it to a shared channel you can then follow.
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (channelUrl.trim()) resolve.mutate();
          }}
        >
          <Input
            autoFocus
            name="channel_url"
            type="url"
            required
            value={channelUrl}
            placeholder="https://www.youtube.com/@channel or https://example.com/feed.xml"
            onChange={(event) => setChannelUrl(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={resolve.isPending} aria-busy={resolve.isPending}>
              {resolve.isPending ? (
                <>
                  <Spinner /> Previewing…
                </>
              ) : (
                "Preview channel"
              )}
            </Button>
          </div>
        </form>
        {resolve.isError && (
          <p className="mt-3 text-sm text-danger" role="alert">
            Could not resolve that channel: {resolve.error.message}
          </p>
        )}
      </Card>
    </div>
  );
}

type FollowFilter = "all" | "errors";
const FOLLOW_FILTER_LABELS: Record<FollowFilter, string> = {
  all: "All",
  errors: "Errors",
};

function FollowingChannels({
  groups,
  onDiscover,
}: {
  groups: Group[];
  onDiscover: () => void;
}) {
  const [filter, setFilter] = useState<FollowFilter>("all");
  const [query, setQuery] = useState("");
  const [polling, setPolling] = useState(0);
  const refetchInterval = polling > 0 ? FOLLOW_REFETCH_ACTIVE_MS : FOLLOW_REFETCH_MS;

  const channels = useInfiniteQuery({
    queryKey: ["channels", "following"],
    queryFn: ({ pageParam }) =>
      api.listChannels({ following: true, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    refetchInterval,
  });
  const rows = channels.data?.pages.flat() ?? [];

  const counts = useMemo(
    () => ({
      all: rows.length,
      errors: rows.filter((channel) => channel.follow?.last_status === "error").length,
    }),
    [rows],
  );
  const search = query.trim().toLowerCase();
  const visible = rows.filter((channel) => {
    if (filter === "errors" && channel.follow?.last_status !== "error") return false;
    if (!search) return true;
    return (channel.title || channel.feed_url).toLowerCase().includes(search);
  });

  const trackPoll = (pending: boolean) =>
    setPolling((count) => Math.max(0, count + (pending ? 1 : -1)));

  if (channels.isLoading) {
    return <LoadingState label="Loading followed channels…" />;
  }
  if (!channels.isError && counts.all === 0) {
    return (
      <EmptyState
        icon={<Rss className="h-5 w-5" />}
        title="You are not following any channels"
        description="Discover the shared catalog and follow a channel to keep it here."
        action={
          <Button size="sm" onClick={onDiscover}>
            Discover channels
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <Toolbar className="mb-0">
        <p className="px-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{counts.all}</span> following
          {counts.errors > 0 && (
            <>
              {" · "}
              <span className="font-medium text-danger">{counts.errors} with errors</span>
            </>
          )}
        </p>
        <label className="relative ml-auto min-w-[180px] max-w-xs flex-1">
          <span className="sr-only">Filter followed channels</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            placeholder="Filter by name"
            className="pl-9"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </Toolbar>

      <ChipRow className="mb-0">
        {(Object.keys(FOLLOW_FILTER_LABELS) as FollowFilter[]).map((value) => (
          <FilterChip
            key={value}
            label={FOLLOW_FILTER_LABELS[value]}
            active={filter === value}
            count={counts[value]}
            onClick={() => setFilter(value)}
          />
        ))}
      </ChipRow>

      {channels.isError && (
        <ErrorState
          message={`Followed channels could not be loaded: ${channels.error.message}`}
          onRetry={() => channels.refetch()}
        />
      )}
      {visible.length === 0 ? (
        <EmptyState
          title="No follows match this view"
          description="Clear the filter or search to see the rest of your channels."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              groups={groups}
              onPoll={trackPoll}
            />
          ))}
        </div>
      )}

      <InfiniteScrollSentinel
        hasNextPage={!!channels.hasNextPage}
        isFetchingNextPage={channels.isFetchingNextPage}
        fetchNextPage={() => channels.fetchNextPage()}
        error={nextPageError(channels)}
        variant="rows"
      />
    </div>
  );
}

function TabLink({
  active,
  icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);
  return debounced;
}
