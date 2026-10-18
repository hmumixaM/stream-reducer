import { ArticleSources } from "./Rss";
import { SubstackSources } from "./Substack";
import { useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Compass, Rss, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { ChannelCard } from "@/components/ChannelCard";
import { ChannelRow } from "@/components/ChannelRow";
import { SourceDiscovery } from "@/components/SourceDiscovery";
import { Button, Card, Input, Spinner } from "@/components/ui";
import {
  ChipRow,
  EmptyState,
  ErrorState,
  FilterChip,
  InfiniteScrollSentinel,
  LoadingState,
  PageHeader,
  SectionHeader,
  Toolbar,
} from "@/components/shell";
import { nextPageError } from "@/lib/useInfiniteScroll";
import {
  api,
  type ChannelRead,
  type Group,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/auth";

const PAGE_SIZE = 24;
// Follows change only when a poll lands, so a slow baseline is plenty; a poll in
// flight temporarily tightens it (see FollowingChannels).
const FOLLOW_REFETCH_MS = 15000;
const FOLLOW_REFETCH_ACTIVE_MS = 3000;

export function Subscriptions() {
  const me = useMe();
  const canFollow = Boolean(me.data?.user);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab =
    requestedTab === "substack" ? "substack" : requestedTab === "articles"
      ? "articles"
      : requestedTab === "following" && canFollow
        ? "following"
        : "discover";
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.listGroups(),
    enabled: canFollow,
  });

  useEffect(() => {
    if (
      requestedTab === "articles" ||
      requestedTab === "substack" ||
      requestedTab === "discover" ||
      (requestedTab === "following" && canFollow)
    ) {
      return;
    }
    const params = new URLSearchParams(searchParams);
    params.set("tab", "discover");
    setSearchParams(params, { replace: true });
  }, [canFollow, requestedTab, searchParams, setSearchParams]);

  const setTab = (next: "discover" | "following" | "articles" | "substack") => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params);
  };

  return (
    <div>
      <PageHeader
        title="Sources"
        subtitle="Follow video, podcast and article sources. New content arrives summarised in Bulletin."
      />

      <nav
        className="mb-6 flex flex-wrap border-b border-border"
        aria-label="Channel views"
      >
        <TabLink
          active={tab === "discover"}
          icon={<Compass className="h-4 w-4" />}
          onClick={() => setTab("discover")}
        >
          Discover
        </TabLink>
        {canFollow && (
          <TabLink
            active={tab === "following"}
            icon={<Rss className="h-4 w-4" />}
            onClick={() => setTab("following")}
          >
            Following
          </TabLink>
        )}
        <TabLink
          active={tab === "articles"}
          icon={<Rss className="h-4 w-4" />}
          onClick={() => setTab("articles")}
        >
          文章 / RSS
        </TabLink>
        <TabLink active={tab === "substack"} icon={<Rss className="h-4 w-4" />} onClick={() => setTab("substack")}>Substack</TabLink>
      </nav>

      {tab === "substack" ? <SubstackSources /> : tab === "articles" ? (
        <ArticleSources />
      ) : tab === "discover" ? (
        <DiscoverChannels groups={groups.data ?? []} canFollow={canFollow} />
      ) : (
        <FollowingChannels
          groups={groups.data ?? []}
          onDiscover={() => setTab("discover")}
        />
      )}
    </div>
  );
}

function DiscoverChannels({
  groups,
  canFollow,
}: {
  groups: Group[];
  canFollow: boolean;
}) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [preview, setPreview] = useState<ChannelRead | null>(null);
  return <div className="space-y-6">
    <SourceDiscovery onAdd={() => setAddOpen(true)} />
    {addOpen && <AddChannelDialog onClose={() => setAddOpen(false)} onResolved={channel => {
      setPreview(channel); setAddOpen(false);
      queryClient.invalidateQueries({ queryKey: ["source-search"] });
    }} />}
    {preview && <section aria-labelledby="channel-preview-title">
      <SectionHeader id="channel-preview-title" title="Channel preview" actions={<Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Dismiss</Button>} />
      <ChannelCard channel={preview} groups={groups} canFollow={canFollow} onFollowChanged={follow => setPreview(channel => channel ? { ...channel, follow } : channel)} />
    </section>}
  </div>;
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
      <Card
        className="w-full max-w-lg p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold">Add a channel by URL</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Paste a YouTube channel, Bilibili space, Apple Podcasts show, 小宇宙
          podcast, or any RSS feed. We resolve it to a shared channel you can
          then follow.
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
            <Button
              type="submit"
              disabled={resolve.isPending}
              aria-busy={resolve.isPending}
            >
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
  const refetchInterval =
    polling > 0 ? FOLLOW_REFETCH_ACTIVE_MS : FOLLOW_REFETCH_MS;

  const channels = useInfiniteQuery({
    queryKey: ["channels", "following"],
    queryFn: ({ pageParam }) =>
      api.listChannels({
        following: true,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    refetchInterval,
  });
  const rows = channels.data?.pages.flat() ?? [];

  const counts = useMemo(
    () => ({
      all: rows.length,
      errors: rows.filter((channel) => channel.follow?.last_status === "error")
        .length,
    }),
    [rows],
  );
  const search = query.trim().toLowerCase();
  const visible = rows.filter((channel) => {
    if (filter === "errors" && channel.follow?.last_status !== "error")
      return false;
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
          <span className="font-medium text-foreground">{counts.all}</span>{" "}
          following
          {counts.errors > 0 && (
            <>
              {" · "}
              <span className="font-medium text-danger">
                {counts.errors} with errors
              </span>
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
