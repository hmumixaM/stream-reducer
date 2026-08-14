import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Bookmark, FolderPlus } from "lucide-react";
import { api, type Item, type Platform } from "@/lib/api";
import { MIRROR } from "@/lib/mirror";
import { Button, Input, Select } from "@/components/ui";
import {
  ChipRow,
  EmptyState,
  FilterChip,
  InfiniteScrollSentinel,
  ItemGrid,
  PageHeader,
  SkeletonGrid,
} from "@/components/shell";
import { nextPageError } from "@/lib/useInfiniteScroll";
import { PLATFORM_LABELS } from "@/components/badges";
import { ItemCard, type ItemCardActions } from "@/components/ItemCard";
import { FolderSection } from "@/components/FolderSection";
import { ITEM_SORTS } from "@/lib/sorts";

const PLATFORMS: Platform[] = ["youtube", "bilibili", "apple_podcast", "xiaoyuzhou", "rss"];
const PAGE_SIZE = 60;
type View = "all" | "favorites" | "archived";

export function Library() {
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState<string>("");
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<string>("added");
  const qc = useQueryClient();

  // Folder-first layout: show folders (and an "Unfiled" section) and lazy-load
  // each section's items only when expanded. Fall back to a cross-folder flat
  // grid only while searching/filtering or in the (typically small) Favorites
  // view, where folder grouping isn't useful.
  const archivedView = view === "archived";
  const filtering = !!q || !!platform;
  const folderFirst = (view === "all" || archivedView) && !filtering;

  const flatParams = {
    q: q || undefined,
    platform: platform || undefined,
    favorite: view === "favorites" ? true : undefined,
    archived: archivedView ? true : false,
    sort,
    order: "desc",
  };
  const items = useInfiniteQuery({
    queryKey: ["items", { q, platform, view, sort, flat: true }],
    queryFn: ({ pageParam }) =>
      api.listItems({ ...flatParams, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined,
    enabled: !folderFirst,
    refetchInterval: 8000,
  });
  // Cheap folder list for the folder-first sections (folders + filtered counts).
  const sectionGroups = useQuery({
    queryKey: ["groups", { archived: archivedView }],
    queryFn: () => api.listGroups(archivedView),
    enabled: folderFirst,
    refetchInterval: 8000,
  });
  // Folder-less items shown directly (as a flat grid) below the folders, sorted
  // by the dropdown. Only fetched in the folder-first view.
  const looseItems = useInfiniteQuery({
    queryKey: ["items", { ungrouped: true, archived: archivedView, sort }],
    queryFn: ({ pageParam }) =>
      api.listItems({
        ungrouped: true,
        archived: archivedView,
        sort,
        order: "desc",
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined,
    enabled: folderFirst,
    refetchInterval: 8000,
  });
  // Full folder list (unfiltered) powers the per-card "move to folder" menu.
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.listGroups(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["items"] });
    qc.invalidateQueries({ queryKey: ["groups"] });
    qc.invalidateQueries({ queryKey: ["ungrouped-count"] });
  };
  const favorite = useMutation({ mutationFn: api.toggleFavorite, onSuccess: invalidate });
  const archive = useMutation({ mutationFn: api.toggleArchive, onSuccess: invalidate });
  const move = useMutation({
    mutationFn: ({ id, gid }: { id: number; gid: number | null }) =>
      api.setItemGroup(id, gid),
    onSuccess: invalidate,
  });
  const createAndMove = useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) => {
      const g = await api.createGroup(title);
      return api.setItemGroup(id, g.id);
    },
    onSuccess: invalidate,
  });
  const newFolder = useMutation({
    mutationFn: (title: string) => api.createGroup(title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });

  const actions: ItemCardActions = {
    onFavorite: favorite.mutate,
    onArchive: archive.mutate,
    groups: groups.data ?? [],
    onMove: (id, gid) => move.mutate({ id, gid }),
    onCreateFolderAndMove: (id, title) => createAndMove.mutate({ id, title }),
  };

  const visibleItems = items.data?.pages.flat() ?? [];
  const sectionFolders = sectionGroups.data ?? [];
  const looseRows = looseItems.data?.pages.flat() ?? [];

  const handleNewFolder = () => {
    const title = window.prompt("New folder name")?.trim();
    if (title) newFolder.mutate(title);
  };

  return (
    <div>
      <PageHeader
        title={MIRROR ? "Library" : "Saved"}
        subtitle={
          folderFirst
            ? `${sectionFolders.length} folder${sectionFolders.length === 1 ? "" : "s"}${
                archivedView ? " of archived items" : ""
              }, plus everything you have not filed.`
            : archivedView
              ? "Items you archived. They stay searchable and keep their summaries."
              : "Everything you saved, with your folders, favorites, and notes."
        }
        actions={
          <>
            {!MIRROR && (
              <Button variant="outline" size="sm" onClick={handleNewFolder}>
                <FolderPlus className="h-4 w-4" />
                <span className="hidden sm:inline">New folder</span>
              </Button>
            )}
            <Select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="w-auto min-w-[130px]"
              title="Sort by"
            >
              {ITEM_SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Input
              placeholder="Search titles..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="max-w-[220px]"
            />
          </>
        }
      />

      {!MIRROR && (
        <ChipRow>
          <FilterChip label="All" active={view === "all"} onClick={() => setView("all")} />
          <FilterChip
            label="★ Favorites"
            active={view === "favorites"}
            onClick={() => setView("favorites")}
          />
          <FilterChip
            label="Archived"
            active={view === "archived"}
            onClick={() => setView("archived")}
          />
        </ChipRow>
      )}

      <ChipRow>
        <FilterChip label="All" active={!platform} onClick={() => setPlatform("")} />
        {PLATFORMS.map((p) => (
          <FilterChip
            key={p}
            label={PLATFORM_LABELS[p]}
            active={platform === p}
            onClick={() => setPlatform(platform === p ? "" : p)}
          />
        ))}
      </ChipRow>

      {folderFirst ? (
        <div className="space-y-4">
          {sectionFolders.length > 0 && (
            <div className="space-y-2">
              {sectionFolders.map((g) => (
                <FolderSection
                  key={g.id}
                  group={g}
                  archived={archivedView}
                  sort={sort}
                  actions={actions}
                />
              ))}
            </div>
          )}
          <LooseGrid
            rows={looseRows}
            isLoading={looseItems.isLoading}
            hasNextPage={!!looseItems.hasNextPage}
            isFetchingNextPage={looseItems.isFetchingNextPage}
            fetchNextPage={() => looseItems.fetchNextPage()}
            pageError={nextPageError(looseItems)}
            onDropDetach={(id) => move.mutate({ id, gid: null })}
            hasFolders={sectionFolders.length > 0}
            archivedView={archivedView}
            actions={actions}
          />
        </div>
      ) : items.isLoading ? (
        <SkeletonGrid count={8} />
      ) : visibleItems.length > 0 ? (
        <>
          <ItemGrid>
            {visibleItems.map((item) => (
              <ItemCard key={item.id} item={item} {...actions} />
            ))}
          </ItemGrid>
          <InfiniteScrollSentinel
            hasNextPage={!!items.hasNextPage}
            isFetchingNextPage={items.isFetchingNextPage}
            fetchNextPage={() => items.fetchNextPage()}
            error={nextPageError(items)}
            totalLabel={`${visibleItems.length} item${visibleItems.length === 1 ? "" : "s"}`}
          />
        </>
      ) : (
        <EmptyState
          icon={<Bookmark className="h-5 w-5" />}
          title={filtering ? "No matching items" : archivedView ? "Nothing archived" : "Nothing saved yet"}
          description={
            filtering
              ? "Try a different search term or platform."
              : MIRROR
                ? "This mirror has no summaries yet."
                : 'Use "Add content" in the sidebar, or add something from your timeline.'
          }
        />
      )}
    </div>
  );
}

/** Folder-less items rendered directly as a flat grid. Doubles as a drop
 * target: dropping a card here detaches it from its current folder. */
function LooseGrid({
  rows,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  pageError,
  onDropDetach,
  hasFolders,
  archivedView,
  actions,
}: {
  rows: Item[];
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  pageError: Error | null;
  onDropDetach: (id: number) => void;
  hasFolders: boolean;
  archivedView: boolean;
  actions: ItemCardActions;
}) {
  const [dragOver, setDragOver] = useState(false);

  if (isLoading) {
    return <SkeletonGrid count={4} />;
  }
  if (rows.length === 0) {
    // Everything is filed: stay quiet when folders exist, otherwise show the
    // empty-library card.
    if (hasFolders) return null;
    return (
      <EmptyState
        icon={<Bookmark className="h-5 w-5" />}
        title={archivedView ? "Nothing archived" : "Nothing saved yet"}
        description={
          MIRROR
            ? "This mirror has no summaries yet."
            : 'Use "Add content" in the sidebar, or add something from your timeline.'
        }
      />
    );
  }
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const id = Number(e.dataTransfer.getData("text/plain"));
        if (id) onDropDetach(id);
      }}
      className={`rounded-lg transition-colors ${
        dragOver ? "bg-accent/50 ring-1 ring-primary" : ""
      }`}
    >
      <ItemGrid>
        {rows.map((item) => (
          <ItemCard key={item.id} item={item} {...actions} />
        ))}
      </ItemGrid>
      <InfiniteScrollSentinel
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        fetchNextPage={fetchNextPage}
        error={pageError}
      />
    </div>
  );
}
