import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  ExternalLink,
  Film,
  Plus,
} from "lucide-react";
import { api, type CollectionTrack, type Item } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { PLATFORM_LABELS, PlatformBadge, StatusBadge } from "@/components/badges";
import { Button, Card, Select } from "@/components/ui";
import { CollectionBulletins } from "@/components/CollectionBulletins";
import {
  ChipRow,
  EmptyState,
  ErrorState,
  FilterChip,
  InfiniteScrollSentinel,
  ItemGrid,
  PageHeader,
  SkeletonGrid,
} from "@/components/shell";
import { nextPageError } from "@/lib/useInfiniteScroll";
import { formatCount } from "@/lib/utils";

const PAGE_SIZE = 60;

export function CollectionDetail() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const bulletinView = params.get("view") !== "videos";
  const selectedSection = params.get("section") || "";
  const selectedTrack = params.get("track_id") || "";
  const setFilter = (name: string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (value) next.set(name, value); else next.delete(name);
    if (name === "section") next.delete("track_id");
    return next;
  }, { replace: true });
  const queryClient = useQueryClient();
  const me = useMe();
  const zh = me.data?.user?.preferred_language === "zh";
  const collection = useQuery({
    queryKey: ["collection", slug],
    queryFn: () => api.getCollection(slug),
    enabled: Boolean(slug),
  });
  const add = useMutation({
    mutationFn: (url: string) => api.addItems([url]),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["collection-track-items", slug],
      });
      queryClient.invalidateQueries({ queryKey: ["browse"] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  if (collection.isLoading) return <SkeletonGrid count={8} />;
  if (collection.isError) {
    return (
      <ErrorState
        message={collection.error.message}
        onRetry={() => collection.refetch()}
      />
    );
  }
  if (!collection.data) {
    return <EmptyState title="Collection not found" description="This collection is unavailable." />;
  }

  const data = collection.data;
  const activeSection =
    data.sections.find((section) => section.slug === selectedSection) ??
    (bulletinView ? undefined : data.sections[0]);
  const tracks = activeSection ? activeSection.tracks : data.sections.flatMap((section) => section.tracks);

  return (
    <div className={bulletinView ? "bulletin-desk mx-auto max-w-5xl pb-14" : ""}>
      <PageHeader
        title={data.title}
        subtitle={zh ? `${data.description} 共 ${data.item_count} 个视频，${data.ready_count} 篇概括可读。` : `${data.description} ${data.ready_count} of ${data.item_count} videos summarized.`}
        backTo="/collections"
        backLabel="Collections"
        actions={
          <a href={data.source_url} target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm">
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Source portal
            </Button>
          </a>
        }
      />

      <div className="desk-toolbar mb-5">
        <div className="flex gap-1" role="group" aria-label={zh ? "Collection 视图" : "Collection view"}>
          <button className={`desk-tab ${bulletinView ? "is-active" : ""}`} aria-pressed={bulletinView} onClick={() => setFilter("view", "bulletin")}>{zh ? "简报" : "Bulletin"}</button>
          <button className={`desk-tab ${!bulletinView ? "is-active" : ""}`} aria-pressed={!bulletinView} onClick={() => setFilter("view", "videos")}>{zh ? "视频目录" : "Video directory"}</button>
        </div>
        {bulletinView && <p className="text-xs text-muted-foreground">{zh ? "从新到旧 · 简报与精炼概括" : "Newest first · Bulletins & summaries"}</p>}
      </div>

      {!bulletinView && data.cover_url ? (
        <div className="mb-6 aspect-[3/1] overflow-hidden rounded-xl border bg-muted">
          <img
            src={data.cover_url}
            alt={`${data.title} conference`}
            width={1200}
            height={400}
            fetchPriority="high"
            className="h-full w-full object-cover"
          />
        </div>
      ) : null}

      <ChipRow>
        {bulletinView && <FilterChip label={zh ? "全部分类" : "All categories"} active={!activeSection} onClick={() => setFilter("section", "")} />}
        {data.sections.map((section) => (
          <FilterChip
            key={section.id}
            label={`${section.title} (${section.item_count})`}
            active={activeSection?.id === section.id}
            onClick={() => setFilter("section", section.slug)}
          />
        ))}
      </ChipRow>

      {bulletinView ? <>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{zh ? "先读概览与要点，再展开精炼概括。" : "Start with the overview and key ideas, then read deeper."}</p>
          <Select value={selectedTrack} onChange={(event) => setFilter("track_id", event.target.value)} aria-label={zh ? "专题" : "Track"} className="w-full bg-transparent sm:w-auto sm:max-w-xs">
            <option value="">{zh ? "全部专题" : "All tracks"}</option>
            {tracks.map((track) => <option key={track.id} value={track.id}>{track.title}</option>)}
          </Select>
        </div>
        <CollectionBulletins slug={slug} section={activeSection?.slug || ""} trackId={selectedTrack} />
      </> : activeSection ? (
        <section aria-labelledby={`collection-section-${activeSection.id}`}>
          <div className="mb-4">
            <h2
              id={`collection-section-${activeSection.id}`}
              className="text-xl font-semibold"
            >
              {activeSection.title}
            </h2>
            <p className="text-sm text-muted-foreground">
              {activeSection.item_count} unique video
              {activeSection.item_count === 1 ? "" : "s"} across{" "}
              {activeSection.tracks.length} tracks
            </p>
          </div>
          <div className="space-y-3">
            {activeSection.tracks.map((track) => (
              <TrackSection
                key={track.id}
                slug={slug}
                track={track}
                canAdd={Boolean(me.data?.user)}
                addingUrl={add.isPending ? add.variables : undefined}
                onAdd={(url) => add.mutate(url)}
              />
            ))}
          </div>
        </section>
      ) : (
        <EmptyState
          title="No categories"
          description="This collection has no category data."
        />
      )}
    </div>
  );
}

function TrackSection({
  slug,
  track,
  canAdd,
  addingUrl,
  onAdd,
}: {
  slug: string;
  track: CollectionTrack;
  canAdd: boolean;
  addingUrl?: string;
  onAdd: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = useInfiniteQuery({
    queryKey: ["collection-track-items", slug, track.id],
    queryFn: ({ pageParam }) =>
      api.listCollectionTrackItems(slug, track.id, {
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    enabled: expanded && track.item_count > 0,
  });
  const rows = items.data?.pages.flat() ?? [];
  const headingId = `collection-track-${track.id}`;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-card shadow-card"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`${headingId}-content`}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        />
        <h3 id={headingId} className="min-w-0 flex-1 font-medium">
          {track.title}
        </h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {track.ready_count}/{track.item_count} summarized
        </span>
      </button>

      {expanded && (
        <div id={`${headingId}-content`} className="px-4 pb-4">
          {track.item_count === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No videos have been published in this track yet.
            </p>
          ) : items.isLoading ? (
            <SkeletonGrid count={Math.min(track.item_count, 8)} />
          ) : items.isError ? (
            <ErrorState
              compact
              message={items.error.message}
              onRetry={() => items.refetch()}
            />
          ) : (
            <>
              <ItemGrid>
                {rows.map((item) => (
                  <CollectionItemCard
                    key={item.id}
                    item={item}
                    canAdd={canAdd}
                    adding={addingUrl === item.source_url}
                    onAdd={() => onAdd(item.source_url)}
                  />
                ))}
              </ItemGrid>
              <InfiniteScrollSentinel
                hasNextPage={Boolean(items.hasNextPage)}
                isFetchingNextPage={items.isFetchingNextPage}
                fetchNextPage={() => items.fetchNextPage()}
                error={nextPageError(items)}
                totalLabel={`${rows.length} video${rows.length === 1 ? "" : "s"}`}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function CollectionItemCard({
  item,
  canAdd,
  adding,
  onAdd,
}: {
  item: Item;
  canAdd: boolean;
  adding: boolean;
  onAdd: () => void;
}) {
  return (
    <Card interactive className="group flex h-full flex-col overflow-hidden">
      <Link to={`/items/${item.id}`} className="block">
        <div className="aspect-video w-full overflow-hidden bg-muted">
          {item.thumbnail ? (
            <img
              src={item.thumbnail}
              alt=""
              width={640}
              height={360}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Film className="h-8 w-8" aria-hidden="true" />
            </div>
          )}
        </div>
      </Link>
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-2 flex items-center gap-2">
          <PlatformBadge platform={item.platform} />
          <StatusBadge status={item.status} />
        </div>
        <Link
          to={`/items/${item.id}`}
          className="mb-2 line-clamp-2 font-medium leading-snug hover:underline"
        >
          {item.title || item.source_url}
        </Link>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {item.author && <span className="truncate">{item.author}</span>}
          {item.view_count != null && (
            <span>{formatCount(item.view_count)} views</span>
          )}
          <span>{PLATFORM_LABELS[item.platform]}</span>
        </div>
        <div className="mt-auto">
          {item.saved ? (
            <Button variant="outline" size="sm" disabled className="w-full">
              <Check className="h-4 w-4" aria-hidden="true" />
              In your library
            </Button>
          ) : canAdd ? (
            <Button size="sm" className="w-full" onClick={onAdd} disabled={adding}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {adding ? "Adding…" : "Add to library"}
            </Button>
          ) : (
            <Link to="/login" className="block">
              <Button variant="outline" size="sm" className="w-full">
                Sign in to add
              </Button>
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}
