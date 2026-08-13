import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeft, CalendarDays, Film, Plus, Radio, Users } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { PlatformBadge, StatusBadge } from "@/components/badges";
import {
  ChannelFollowControls,
  invalidateChannelQueries,
} from "@/components/ChannelFollowControls";
import { ItemCard, type ItemCardActions } from "@/components/ItemCard";
import { Button, Card, Input, Spinner } from "@/components/ui";
import {
  api,
  type ChannelFollowRead,
  type ChannelItemRead,
} from "@/lib/api";
import { formatCount, formatDate } from "@/lib/utils";

const PAGE_SIZE = 30;

export function ChannelDetail() {
  const { id } = useParams();
  const channelId = Number(id);
  const validId = Number.isInteger(channelId) && channelId > 0;
  const queryClient = useQueryClient();

  const channel = useQuery({
    queryKey: ["channel", channelId],
    queryFn: () => api.getChannel(channelId),
    enabled: validId,
    refetchInterval: 5000,
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.listGroups(),
    enabled: validId,
  });
  const items = useInfiniteQuery({
    queryKey: ["channel", channelId, "items"],
    queryFn: ({ pageParam }) =>
      api.listChannelItems(channelId, { limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    enabled: validId,
  });

  const invalidateItems = () => {
    queryClient.invalidateQueries({ queryKey: ["channel", channelId, "items"] });
    queryClient.invalidateQueries({ queryKey: ["items"] });
    queryClient.invalidateQueries({ queryKey: ["groups"] });
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
    return <PageError message="That channel ID is invalid." />;
  }
  if (channel.isLoading) {
    return <LoadingState />;
  }
  if (channel.isError) {
    return (
      <PageError
        message={`Channel could not be loaded: ${channel.error.message}`}
        onRetry={() => channel.refetch()}
      />
    );
  }
  if (!channel.data) return null;

  const title = channel.data.title || channel.data.feed_url;

  return (
    <div>
      <Link
        to="/subscriptions?tab=discover"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Channels
      </Link>

      <Card className="mb-6 p-5">
        <div className="flex flex-col gap-5 md:flex-row">
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
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <PlatformBadge platform={channel.data.platform} />
              {channel.data.follow && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  Following
                </span>
              )}
            </div>
            <h1 className="break-words text-2xl font-semibold">{title}</h1>
            <div className="mt-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
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
            <div className="mt-5 border-t border-border pt-4">
              <ChannelFollowControls
                channelId={channelId}
                follow={channel.data.follow}
                groups={groups.data ?? []}
                showManagement
              />
            </div>
          </div>
        </div>
      </Card>

      {channel.data.follow && (
        <ChannelAnnotations
          channelId={channelId}
          follow={channel.data.follow}
        />
      )}

      <section aria-labelledby="channel-items-title">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 id="channel-items-title" className="text-lg font-semibold">
              Channel items
            </h2>
            <p className="text-sm text-muted-foreground">
              Items not already in your library can be added individually.
            </p>
          </div>
          {!items.isLoading && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {rows.length}{items.hasNextPage ? "+" : ""} shown
            </span>
          )}
        </div>

        {items.isLoading ? (
          <Card className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
            <Spinner /> Loading channel items…
          </Card>
        ) : items.isError ? (
          <PageError
            message={`Channel items could not be loaded: ${items.error.message}`}
            onRetry={() => items.refetch()}
          />
        ) : rows.length === 0 ? (
          <Card className="p-10 text-center text-muted-foreground">
            No items have been discovered for this channel yet.
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {rows.map((item) =>
                item.in_library ? (
                  <ItemCard key={item.id} item={item} {...actions} />
                ) : (
                  <ChannelCatalogItem
                    key={item.id}
                    item={item}
                    adding={
                      addToLibrary.isPending && addToLibrary.variables?.id === item.id
                    }
                    onAdd={() => addToLibrary.mutate(item)}
                  />
                ),
              )}
            </div>
            {addToLibrary.isError && (
              <p className="mt-3 text-sm text-red-400" role="alert">
                Could not add that item: {addToLibrary.error.message}
              </p>
            )}
            {items.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <Button
                  variant="outline"
                  disabled={items.isFetchingNextPage}
                  aria-busy={items.isFetchingNextPage}
                  onClick={() => items.fetchNextPage()}
                >
                  {items.isFetchingNextPage ? (
                    <>
                      <Spinner /> Loading…
                    </>
                  ) : (
                    "Load more"
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ChannelCatalogItem({
  item,
  adding,
  onAdd,
}: {
  item: ChannelItemRead;
  adding: boolean;
  onAdd: () => void;
}) {
  return (
    <Card className="group flex h-full flex-col overflow-hidden transition-colors hover:border-primary">
      <Link to={`/items/${item.id}`} className="block">
        <div className="aspect-video w-full overflow-hidden bg-muted">
          {item.thumbnail ? (
            <img
              src={item.thumbnail}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Film className="h-8 w-8" />
            </div>
          )}
        </div>
      </Link>
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <PlatformBadge platform={item.platform} />
          <StatusBadge status={item.status} />
          <span className="text-xs text-muted-foreground">Not in library</span>
        </div>
        <Link
          to={`/items/${item.id}`}
          className="line-clamp-2 font-medium leading-snug hover:text-primary hover:underline"
        >
          {item.title || item.source_url}
        </Link>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {item.author && <span className="truncate">{item.author}</span>}
          {item.published_at && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" />
              {formatDate(item.published_at)}
            </span>
          )}
        </div>
        <Button
          className="mt-4 w-full"
          size="sm"
          disabled={adding}
          aria-busy={adding}
          onClick={onAdd}
        >
          {adding ? <Spinner /> : <Plus className="h-4 w-4" />}
          Add to library
        </Button>
      </div>
    </Card>
  );
}

function ChannelAnnotations({
  channelId,
  follow,
}: {
  channelId: number;
  follow: ChannelFollowRead;
}) {
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

  return (
    <Card className="mb-6 p-4">
      <h2 className="mb-1 font-semibold">Channel notes</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Notes remain attached to this follow.
      </p>
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
        <p className="mt-2 text-sm text-red-400" role="alert">
          {addComment.error.message}
        </p>
      )}
      {annotations.isLoading && (
        <p className="mt-3 text-sm text-muted-foreground">Loading notes…</p>
      )}
      {annotations.isError && (
        <p className="mt-3 text-sm text-red-400" role="alert">
          Notes could not be loaded: {annotations.error.message}
        </p>
      )}
      {(annotations.data ?? []).length > 0 && (
        <div className="mt-3 space-y-2">
          {(annotations.data ?? []).map((annotation) => (
            <p
              key={`${annotation.kind}-${annotation.id}`}
              className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
            >
              {annotation.body || annotation.quote}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

function LoadingState() {
  return (
    <Card className="flex items-center justify-center gap-2 p-10 text-muted-foreground">
      <Spinner /> Loading channel…
    </Card>
  );
}

function PageError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Card className="p-10 text-center">
      <p className="text-sm text-red-400" role="alert">
        {message}
      </p>
      {onRetry && (
        <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Card>
  );
}
