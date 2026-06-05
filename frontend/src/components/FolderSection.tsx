import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { ChevronRight, Folder, Inbox } from "lucide-react";
import { api, type Group, type Item } from "@/lib/api";
import { Button } from "@/components/ui";
import { ItemCard, type ItemCardActions } from "@/components/ItemCard";

const PAGE_SIZE = 60;

/** Collapsible section shell that doubles as a drag-and-drop target. The body
 * is only mounted while expanded, so collapsed sections issue zero item
 * requests (their lazy queries never run). */
function CollapsibleSection({
  icon,
  title,
  count,
  onDropItem,
  expanded,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  count: number;
  onDropItem: (itemId: number) => void;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const [dragOver, setDragOver] = useState(false);

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
        if (id) onDropItem(id);
      }}
      className={`rounded-lg border transition-colors ${
        dragOver ? "border-primary bg-accent/50" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          />
          {icon}
          <span className="min-w-0 truncate font-medium">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {count} item{count === 1 ? "" : "s"}
          </span>
        </button>
      </div>
      {expanded && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export function FolderSection({
  group,
  archived,
  actions,
}: {
  group: Group;
  archived: boolean;
  actions: ItemCardActions;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <CollapsibleSection
      icon={<Folder className="h-4 w-4 shrink-0 text-primary" />}
      title={
        <Link
          to={`/folders/${group.id}`}
          onClick={(e) => e.stopPropagation()}
          className="hover:underline"
        >
          {group.title || "Folder"}
        </Link>
      }
      count={group.item_count}
      onDropItem={(id) => actions.onMove(id, group.id)}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {expanded && (
        <FolderItems groupId={group.id} archived={archived} actions={actions} />
      )}
    </CollapsibleSection>
  );
}

function FolderItems({
  groupId,
  archived,
  actions,
}: {
  groupId: number;
  archived: boolean;
  actions: ItemCardActions;
}) {
  const items = useInfiniteQuery({
    queryKey: ["items", { group_id: groupId, archived }],
    queryFn: ({ pageParam }) =>
      api.listItems({
        group_id: groupId,
        archived,
        sort: "position",
        order: "asc",
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined,
    refetchInterval: 8000,
  });
  return <ItemGrid items={items} actions={actions} emptyLabel="No items here." />;
}

/** The "Unfiled" pseudo-folder: ungrouped items, lazy + paginated. Dropping a
 * card here detaches it from its current folder. */
export function UnfiledSection({
  archived,
  actions,
}: {
  archived: boolean;
  actions: ItemCardActions;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = useQuery({
    queryKey: ["ungrouped-count", { archived }],
    queryFn: () => api.listItems({ ungrouped: true, archived, limit: 500 }),
    select: (rows) => rows.length,
    refetchInterval: 8000,
  });
  return (
    <CollapsibleSection
      icon={<Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />}
      title="Unfiled"
      count={count.data ?? 0}
      onDropItem={(id) => actions.onMove(id, null)}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {expanded && <UnfiledItems archived={archived} actions={actions} />}
    </CollapsibleSection>
  );
}

function UnfiledItems({
  archived,
  actions,
}: {
  archived: boolean;
  actions: ItemCardActions;
}) {
  const items = useInfiniteQuery({
    queryKey: ["items", { ungrouped: true, archived }],
    queryFn: ({ pageParam }) =>
      api.listItems({
        ungrouped: true,
        archived,
        sort: "added",
        order: "desc",
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined,
    refetchInterval: 8000,
  });
  return <ItemGrid items={items} actions={actions} emptyLabel="Nothing unfiled." />;
}

function ItemGrid({
  items,
  actions,
  emptyLabel,
}: {
  items: UseInfiniteQueryResult<{ pages: Item[][] }>;
  actions: ItemCardActions;
  emptyLabel: string;
}) {
  const rows = items.data?.pages.flat() ?? [];
  if (items.isLoading) {
    return <p className="py-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (rows.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {rows.map((item) => (
          <ItemCard key={item.id} item={item} {...actions} />
        ))}
      </div>
      {items.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => items.fetchNextPage()}
            disabled={items.isFetchingNextPage}
          >
            {items.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}
