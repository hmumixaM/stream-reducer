import { useEffect, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Compass, RefreshCw, Rss, Search, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { PlatformBadge } from "@/components/badges";
import { ChannelCard } from "@/components/ChannelCard";
import { Button, Card, Input, Select, Spinner, Switch } from "@/components/ui";
import {
  api,
  type ChannelFollowRead,
  type ChannelRead,
  type Platform,
  type Subscription,
} from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";

const PAGE_SIZE = 24;
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
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Channels</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Discover known channels, follow the ones you care about, and optionally receive
          new items automatically.
        </p>
      </div>

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

function DiscoverChannels({
  groups,
}: {
  groups: Awaited<ReturnType<typeof api.listGroups>>;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [channelUrl, setChannelUrl] = useState("");
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
  const resolve = useMutation({
    mutationFn: () => api.resolveChannel(channelUrl.trim()),
    onMutate: () => setPreview(null),
    onSuccess: (channel) => {
      setPreview(channel);
      queryClient.invalidateQueries({ queryKey: ["channels", "catalog"] });
    },
  });
  const rows = channels.data?.pages.flat() ?? [];
  const filtering = Boolean(debouncedQuery || platform);

  const updatePreviewFollow = (follow: ChannelFollowRead | null) => {
    setPreview((channel) => (channel ? { ...channel, follow } : channel));
  };

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <form
          method="get"
          action="/subscriptions"
          className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="block text-xs font-medium text-muted-foreground">
            Search channel names
            <span className="relative mt-1 block">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4" />
              <Input
                name="q"
                value={query}
                maxLength={100}
                placeholder="Search known channels"
                className="pl-9"
                onChange={(event) => setQuery(event.target.value)}
              />
            </span>
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Platform
            <Select
              name="platform"
              className="mt-1"
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
          </label>
        </form>
      </Card>

      <Card className="p-4">
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (channelUrl.trim()) resolve.mutate();
          }}
        >
          <label className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
            Paste a channel or feed URL
            <Input
              name="channel_url"
              type="url"
              required
              className="mt-1"
              value={channelUrl}
              placeholder="https://www.youtube.com/@channel or https://example.com/feed.xml"
              onChange={(event) => {
                setChannelUrl(event.target.value);
                if (preview) setPreview(null);
              }}
            />
          </label>
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
        </form>
        {resolve.isError && (
          <p className="mt-3 text-sm text-red-400" role="alert">
            Could not resolve that channel: {resolve.error.message}
          </p>
        )}
      </Card>

      {preview && (
        <section aria-labelledby="channel-preview-title">
          <h2 id="channel-preview-title" className="mb-3 text-sm font-semibold">
            Channel preview
          </h2>
          <ChannelCard
            channel={preview}
            groups={groups}
            onFollowChanged={updatePreviewFollow}
          />
        </section>
      )}

      <section aria-labelledby="known-channels-title">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="known-channels-title" className="text-lg font-semibold">
            Known channels
          </h2>
          {!channels.isLoading && (
            <span className="text-xs text-muted-foreground">
              {rows.length}{channels.hasNextPage ? "+" : ""} shown
            </span>
          )}
        </div>
        {channels.isLoading ? (
          <LoadingState label="Loading channels…" />
        ) : channels.isError ? (
          <ErrorState
            message={`Channels could not be loaded: ${channels.error.message}`}
            onRetry={() => channels.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtering ? "No matching channels" : "No known channels yet"}
            description={
              filtering
                ? "Try another name or platform."
                : "Paste a channel or feed URL above to add the first one to the catalog."
            }
          />
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              {rows.map((channel) => (
                <ChannelCard key={channel.id} channel={channel} groups={groups} />
              ))}
            </div>
            {channels.hasNextPage && (
              <LoadMore
                loading={channels.isFetchingNextPage}
                onClick={() => channels.fetchNextPage()}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function FollowingChannels({
  groups,
  onDiscover,
}: {
  groups: Awaited<ReturnType<typeof api.listGroups>>;
  onDiscover: () => void;
}) {
  const channels = useInfiniteQuery({
    queryKey: ["channels", "following"],
    queryFn: ({ pageParam }) =>
      api.listChannels({ following: true, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    refetchInterval: 5000,
  });
  const legacySubscriptions = useQuery({
    queryKey: ["subs"],
    queryFn: api.listSubscriptions,
    refetchInterval: 5000,
  });
  const rows = channels.data?.pages.flat() ?? [];
  const legacyRows = (legacySubscriptions.data ?? []).filter(
    (subscription) => subscription.channel_id == null,
  );

  if (channels.isLoading || legacySubscriptions.isLoading) {
    return <LoadingState label="Loading followed channels…" />;
  }
  if (
    !channels.isError &&
    !legacySubscriptions.isError &&
    rows.length === 0 &&
    legacyRows.length === 0
  ) {
    return (
      <EmptyState
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
    <div className="space-y-6">
      {channels.isError && (
        <ErrorState
          message={`Followed channels could not be loaded: ${channels.error.message}`}
          onRetry={() => channels.refetch()}
        />
      )}
      {rows.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              groups={groups}
              management
            />
          ))}
        </div>
      )}
      {channels.hasNextPage && (
        <LoadMore
          loading={channels.isFetchingNextPage}
          onClick={() => channels.fetchNextPage()}
        />
      )}
      {legacySubscriptions.isError && (
        <ErrorState
          message={`Legacy follows could not be loaded: ${legacySubscriptions.error.message}`}
          onRetry={() => legacySubscriptions.refetch()}
        />
      )}
      {legacyRows.length > 0 && (
        <section aria-labelledby="legacy-follows-title">
          <div className="mb-3">
            <h2 id="legacy-follows-title" className="text-lg font-semibold">
              Follows awaiting migration
            </h2>
            <p className="text-sm text-muted-foreground">
              These existing follows remain manageable while they are linked to the
              shared channel catalog.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {legacyRows.map((subscription) => (
              <LegacyFollowCard
                key={subscription.id}
                subscription={subscription}
                groups={groups}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LegacyFollowCard({
  subscription,
  groups,
}: {
  subscription: Subscription;
  groups: Awaited<ReturnType<typeof api.listGroups>>;
}) {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["subs"] }),
      queryClient.invalidateQueries({ queryKey: ["channels", "catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["channels", "following"] }),
    ]);
  const toggle = useMutation({
    mutationFn: () => api.toggleSubscription(subscription.id),
    onSuccess: refresh,
  });
  const updateFolder = useMutation({
    mutationFn: (folderId: number | null) =>
      api.updateSubscription(subscription.id, { folder_id: folderId }),
    onSuccess: refresh,
  });
  const poll = useMutation({
    mutationFn: () => api.pollSubscription(subscription.id),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSubscription(subscription.id),
    onSuccess: refresh,
  });
  const pending =
    toggle.isPending ||
    updateFolder.isPending ||
    poll.isPending ||
    remove.isPending;
  const mutationError =
    toggle.error ?? updateFolder.error ?? poll.error ?? remove.error;
  const followsLatest = subscription.follow_latest ?? subscription.enabled;

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <PlatformBadge platform={subscription.platform} />
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
          Awaiting migration
        </span>
      </div>
      <h3 className="break-words font-semibold">
        {subscription.title || subscription.feed_url}
      </h3>
      <p className="mt-1 break-all text-xs text-muted-foreground">
        {subscription.feed_url}
      </p>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>Every {subscription.interval_minutes}m</span>
        <span>Last {subscription.window_days}d</span>
        <span>
          {subscription.last_checked_at
            ? `Checked ${timeAgo(subscription.last_checked_at)}`
            : "Never checked"}
        </span>
        {subscription.last_status && <span>Status: {subscription.last_status}</span>}
      </div>
      {subscription.last_error && (
        <p className="mt-2 break-words text-xs text-red-400">
          Last poll failed: {subscription.last_error}
        </p>
      )}
      <div className="mt-4 space-y-3 border-t border-border pt-4">
        <Switch
          checked={followsLatest}
          disabled={pending}
          label="Follow latest"
          onCheckedChange={() => toggle.mutate()}
        />
        <label className="block text-xs font-medium text-muted-foreground">
          Folder
          <Select
            className="mt-1"
            value={
              subscription.folder_id != null ? String(subscription.folder_id) : ""
            }
            disabled={!followsLatest || pending}
            onChange={(event) =>
              updateFolder.mutate(
                event.target.value ? Number(event.target.value) : null,
              )
            }
          >
            <option value="">Unfiled</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.title || "Folder"}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!followsLatest || pending}
            aria-busy={poll.isPending}
            onClick={() => poll.mutate()}
          >
            {poll.isPending ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
            Poll now
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            aria-busy={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "Unfollow this channel? Existing library items will be kept.",
                )
              ) {
                remove.mutate();
              }
            }}
          >
            {remove.isPending ? <Spinner /> : <Trash2 className="h-4 w-4" />}
            Unfollow
          </Button>
        </div>
        {mutationError && (
          <p className="text-sm text-red-400" role="alert">
            {mutationError.message}
          </p>
        )}
      </div>
    </Card>
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
        "-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium",
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

function LoadingState({ label }: { label: string }) {
  return (
    <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
      <Spinner /> {label}
    </Card>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="p-8 text-center">
      <p className="mb-3 text-sm text-red-400" role="alert">
        {message}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </Card>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="p-10 text-center">
      <h3 className="font-medium">{title}</h3>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </Card>
  );
}

function LoadMore({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <div className="mt-6 flex justify-center">
      <Button
        variant="outline"
        disabled={loading}
        aria-busy={loading}
        onClick={onClick}
      >
        {loading ? (
          <>
            <Spinner /> Loading…
          </>
        ) : (
          "Load more"
        )}
      </Button>
    </div>
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
