import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronDown,
  Film,
  Radio,
  Settings2,
  Users,
} from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";
import { PlatformBadge } from "@/components/badges";
import {
  ChannelFollowControls,
  PollHealth,
  invalidateChannelQueries,
} from "@/components/ChannelFollowControls";
import { CatalogItemCard } from "@/components/CatalogItemCard";
import { ItemCard, type ItemCardActions } from "@/components/ItemCard";
import { Button, Card, Input, Select, Spinner } from "@/components/ui";
import {
  BackLink,
  EmptyState,
  ErrorState,
  FilterChip,
  InfiniteScrollSentinel,
  ItemGrid,
  LoadingState,
  SectionHeader,
  SkeletonGrid,
} from "@/components/shell";
import { CHANNEL_ITEM_SORTS } from "@/lib/sorts";
import { nextPageError } from "@/lib/useInfiniteScroll";
import {
  api,
  type ChannelFollowRead,
  type ChannelItemRead,
} from "@/lib/api";
import { cn, formatCount } from "@/lib/utils";

const PAGE_SIZE = 30;
type SavedFilter = "all" | "saved" | "unsaved";
const SAVED_LABELS: Record<SavedFilter, string> = {
  all: "All",
  saved: "In library",
  unsaved: "Not in library",
};

export function ChannelDetail() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const channelId = Number(id);
  const validId = Number.isInteger(channelId) && channelId > 0;
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const sort = searchParams.get("sort") ?? "published";
  const savedFilter = (searchParams.get("saved") ?? "all") as SavedFilter;
  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    setSearchParams(params, { replace: true });
  };

  const channel = useQuery({
    queryKey: ["channel", channelId],
    queryFn: () => api.getChannel(channelId),
    enabled: validId,
    refetchInterval: 15000,
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.listGroups(),
    enabled: validId,
  });
  const items = useInfiniteQuery({
    queryKey: ["channel", channelId, "items", { sort, saved: savedFilter }],
    queryFn: ({ pageParam }) =>
      api.listChannelItems(channelId, {
        sort,
        saved: savedFilter === "all" ? undefined : savedFilter === "saved",
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    enabled: validId,
  });

  const invalidateItems = () => {
    queryClient.invalidateQueries({ queryKey: ["channel", channelId, "items"] });
    queryClient.invalidateQueries({ queryKey: ["items"] });
    queryClient.invalidateQueries({ queryKey: ["groups"] });
    queryClient.invalidateQueries({ queryKey: ["timeline"] });
  };
  const favorite = useMutation({ mutationFn: api.toggleFavorite, onSuccess: invalidateItems });
  const archive = useMutation({ mutationFn: api.toggleArchive, onSuccess: invalidateItems });
  const move = useMutation({
    mutationFn: ({ itemId, groupId }: { itemId: number; groupId: number | null }) =>
      api.setItemGroup(itemId, groupId),
    onSuccess: invalidateItems,
  });
  const createAndMove = useMutation({
    mutationFn: async ({ itemId, title }: { itemId: number; title: string }) => {
      const group = await api.createGroup(title);
      return api.setItemGroup(itemId, group.id);
    },
    onSuccess: invalidateItems,
  });
  const addToLibrary = useMutation({
    mutationFn: async (item: ChannelItemRead) => {
      const added = await api.addItems(
        [item.source_url],
        channel.data?.follow?.folder_id,
      );
      if (added.length === 0) {
        throw new Error("The server did not add this item to the library.");
      }
      return added;
    },
    onSuccess: (_added, item) => {
      invalidateItems();
      queryClient.invalidateQueries({ queryKey: ["browse"] });
      queryClient.invalidateQueries({ queryKey: ["item", item.id] });
      queryClient.invalidateQueries({ queryKey: ["queue"] });
      invalidateChannelQueries(queryClient, channelId);
    },
  });

  const actions: ItemCardActions = {
    onFavorite: favorite.mutate,
    onArchive: archive.mutate,
    groups: groups.data ?? [],
    onMove: (itemId, groupId) => move.mutate({ itemId, groupId }),
    onCreateFolderAndMove: (itemId, title) => createAndMove.mutate({ itemId, title }),
  };
  const rows = items.data?.pages.flat() ?? [];

  if (!validId) {
    return <ErrorState message="That channel ID is invalid." />;
  }
  if (channel.isLoading) {
    return <LoadingState label="Loading channel…" />;
  }
  if (channel.isError) {
    return (
      <ErrorState
        message={`Channel could not be loaded: ${channel.error.message}`}
        onRetry={() => channel.refetch()}
      />
    );
  }
  if (!channel.data) return null;

  const follow = channel.data.follow;

  return (
    <div>
      <BackLink to="/subscriptions?tab=discover" label="Channels" />

      <Card className="mb-6 p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-4">
            <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted text-muted-foreground">
              {channel.data.image_url ? (
                <img
                  src={channel.data.image_url}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <Radio className="h-10 w-10" />
              )}
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <PlatformBadge platform={channel.data.platform} />
                {follow && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    Following
                  </span>
                )}
              </div>
              <h1 className="break-words text-display font-semibold">
                {channel.data.title || channel.data.feed_url}
              </h1>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Users className="h-4 w-4" />
                  {formatCount(channel.data.follower_count)} followers
                </span>
                <span>{formatCount(channel.data.item_count)} items</span>
                {channel.data.source_url && (
                  <a
                    href={channel.data.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-foreground hover:underline"
                  >
                    Open source
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="flex w-full flex-col items-stretch gap-3 lg:w-72 lg:shrink-0">
            <ChannelFollowControls
              channelId={channelId}
              follow={follow}
              groups={groups.data ?? []}
            />
            {follow && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-between"
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  <span className="inline-flex items-center gap-2">
                    <Settings2 className="h-4 w-4" /> Follow settings
                  </span>
                  <ChevronDown
                    className={cn("h-4 w-4 transition-transform", settingsOpen && "rotate-180")}
                  />
                </Button>
                <PollHealth follow={follow} />
              </>
            )}
          </div>
        </div>

        {follow && settingsOpen && (
          <div className="mt-5 border-t border-border pt-4">
            <ChannelFollowControls
              settingsOpen
              showFollowButton={false}
              channelId={channelId}
              follow={follow}
              groups={groups.data ?? []}
            />
          </div>
        )}
      </Card>

      {follow && <ChannelNotes channelId={channelId} follow={follow} />}

      <section aria-labelledby="channel-items-title">
        <SectionHeader
          id="channel-items-title"
          title="Channel items"
          subtitle="Items not already in your library can be added individually."
          actions={
            <>
              {(Object.keys(SAVED_LABELS) as SavedFilter[]).map((value) => (
                <FilterChip
                  key={value}
                  label={SAVED_LABELS[value]}
                  active={savedFilter === value}
                  onClick={() => setParam("saved", value === "all" ? "" : value)}
                />
              ))}
              <Select
                value={sort}
                className="w-auto min-w-[160px]"
                title="Sort by"
                onChange={(event) => setParam("sort", event.target.value)}
              >
                {CHANNEL_ITEM_SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </>
          }
        />

        {items.isLoading ? (
          <SkeletonGrid count={8} />
        ) : items.isError ? (
          <ErrorState
            message={`Channel items could not be loaded: ${items.error.message}`}
            onRetry={() => items.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Film className="h-5 w-5" />}
            title={
              savedFilter === "all"
                ? "No items discovered yet"
                : "No items match this filter"
            }
            description={
              savedFilter === "all"
                ? "Items appear here as this channel's feed is polled."
                : "Switch back to All to see everything this channel has surfaced."
            }
          />
        ) : (
          <>
            <ItemGrid>
              {rows.map((item) =>
                item.in_library ? (
                  <ItemCard key={item.id} item={item} {...actions} />
                ) : (
                  <CatalogItemCard
                    key={item.id}
                    item={item}
                    adding={
                      addToLibrary.isPending && addToLibrary.variables?.id === item.id
                    }
                    onAdd={() => addToLibrary.mutate(item)}
                  />
                ),
              )}
            </ItemGrid>
            {addToLibrary.isError && (
              <p className="mt-3 text-sm text-danger" role="alert">
                Could not add that item: {addToLibrary.error.message}
              </p>
            )}
            <InfiniteScrollSentinel
              hasNextPage={!!items.hasNextPage}
              isFetchingNextPage={items.isFetchingNextPage}
              fetchNextPage={() => items.fetchNextPage()}
              error={nextPageError(items)}
              totalLabel={`${rows.length} item${rows.length === 1 ? "" : "s"}`}
            />
          </>
        )}
      </section>
    </div>
  );
}

/** Notes attached to the follow, collapsed to a summary row until opened. */
function ChannelNotes({
  channelId,
  follow,
}: {
  channelId: number;
  follow: ChannelFollowRead;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const queryClient = useQueryClient();
  const annotations = useQuery({
    queryKey: ["sub-annotations", follow.id],
    queryFn: () => api.listSubscriptionAnnotations(follow.id),
  });
  const addComment = useMutation({
    mutationFn: () => api.addSubscriptionComment(follow.id, comment.trim()),
    onSuccess: () => {
      setComment("");
      queryClient.invalidateQueries({ queryKey: ["sub-annotations", follow.id] });
      queryClient.invalidateQueries({ queryKey: ["channel", channelId] });
    },
  });
  const notes = annotations.data ?? [];

  return (
    <Card className="mb-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="font-semibold">
          Channel notes
          {notes.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {notes.length}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-border p-4">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (comment.trim()) addComment.mutate();
            }}
          >
            <label className="sr-only" htmlFor={`channel-${channelId}-comment`}>
              Add a channel note
            </label>
            <Input
              id={`channel-${channelId}-comment`}
              name="comment"
              value={comment}
              placeholder="Add a note about this channel"
              onChange={(event) => setComment(event.target.value)}
            />
            <Button
              type="submit"
              disabled={addComment.isPending || !comment.trim()}
              aria-busy={addComment.isPending}
            >
              {addComment.isPending ? (
                <>
                  <Spinner /> Adding note…
                </>
              ) : (
                "Add note"
              )}
            </Button>
          </form>
          {addComment.isError && (
            <p className="mt-2 text-sm text-danger" role="alert">
              {addComment.error.message}
            </p>
          )}
          {annotations.isLoading && (
            <p className="mt-3 text-sm text-muted-foreground">Loading notes…</p>
          )}
          {annotations.isError && (
            <p className="mt-3 text-sm text-danger" role="alert">
              Notes could not be loaded: {annotations.error.message}
            </p>
          )}
          {notes.length > 0 && (
            <div className="mt-3 space-y-2">
              {notes.map((annotation) => (
                <p
                  key={`${annotation.kind}-${annotation.id}`}
                  className="rounded-md bg-card-muted px-3 py-2 text-sm text-muted-foreground"
                >
                  {annotation.body || annotation.quote}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
