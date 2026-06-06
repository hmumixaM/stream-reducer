import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { FolderPlus } from "lucide-react";
import { api } from "@/lib/api";
import { MIRROR } from "@/lib/mirror";
import { Button, Card, Input, Select } from "@/components/ui";
import { ItemCard, type ItemCardActions } from "@/components/ItemCard";
import { FolderSection, UnfiledSection } from "@/components/FolderSection";

const PLATFORMS = ["youtube", "bilibili", "apple_podcast", "xiaoyuzhou", "rss"];
const PAGE_SIZE = 60;
type View = "all" | "favorites" | "archived";

const SORTS: { value: string; label: string }[] = [
  { value: "added", label: "Recently added" },
  { value: "published", label: "Publish date" },
  { value: "views", label: "Most views" },
  { value: "likes", label: "Most likes" },
  { value: "duration", label: "Longest" },
];

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

  const handleNewFolder = () => {
    const title = window.prompt("New folder name")?.trim();
    if (title) newFolder.mutate(title);
  };

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Library</h1>
          <p className="text-sm text-muted-foreground">
            {folderFirst
              ? `${sectionFolders.length} folder${sectionFolders.length === 1 ? "" : "s"}`
              : `${visibleItems.length}${items.hasNextPage ? "+" : ""} ${
                  archivedView ? "archived" : "summaries"
                }`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!MIRROR && (
            <Button variant="outline" size="sm" onClick={handleNewFolder}>
              <FolderPlus className="h-4 w-4" /> <span className="hidden sm:inline">New folder</span>
            </Button>
          )}
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="w-auto min-w-[120px]"
            title="Sort by"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Input
            placeholder="Search titles..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
        </div>
      </div>

      {!MIRROR && (
        <div className="mb-4 flex flex-wrap gap-2">
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
        </div>
      )}

      <div className="mb-5 flex flex-wrap gap-2">
        <FilterChip label="All" active={!platform} onClick={() => setPlatform("")} />
        {PLATFORMS.map((p) => (
          <FilterChip
            key={p}
            label={p}
            active={platform === p}
            onClick={() => setPlatform(platform === p ? "" : p)}
          />
        ))}
      </div>

      {folderFirst ? (
        <div className="space-y-2">
          {sectionFolders.map((g) => (
            <FolderSection
              key={g.id}
              group={g}
              archived={archivedView}
              actions={actions}
            />
          ))}
          <UnfiledSection archived={archivedView} actions={actions} />
        </div>
      ) : items.isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : visibleItems.length > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {visibleItems.map((item) => (
              <ItemCard key={item.id} item={item} {...actions} />
            ))}
          </div>
          {items.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="outline"
                onClick={() => items.fetchNextPage()}
                disabled={items.isFetchingNextPage}
              >
                {items.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      ) : (
        <Card className="p-10 text-center text-muted-foreground">
          {filtering
            ? "No matching items."
            : MIRROR
              ? "No summaries yet."
              : 'No summaries yet. Click "Add content" to get started.'}
        </Card>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent"
      }`}
    >
      {label.replace("_", " ")}
    </button>
  );
}
