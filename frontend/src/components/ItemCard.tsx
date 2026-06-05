import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  Check,
  Clock,
  Coins,
  Eye,
  Film,
  FolderInput,
  FolderPlus,
  Star,
  ThumbsUp,
  X,
} from "lucide-react";
import type { Group, Item } from "@/lib/api";
import { Card } from "@/components/ui";
import { PlatformBadge, StatusBadge } from "@/components/badges";
import { formatCost, formatCount, formatDate, formatMs, timeAgo } from "@/lib/utils";

export interface ItemCardActions {
  onFavorite: (id: number) => void;
  onArchive: (id: number) => void;
  groups: Group[];
  onMove: (itemId: number, groupId: number | null) => void;
  onCreateFolderAndMove: (itemId: number, title: string) => void;
}

export function ItemCard({ item, ...actions }: { item: Item } & ItemCardActions) {
  return (
    <Link
      to={`/items/${item.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(item.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab active:cursor-grabbing"
    >
      <Card className="group relative h-full overflow-hidden transition-colors hover:border-primary">
        <div className="absolute right-2 top-2 z-10 flex gap-1">
          <FolderMenu item={item} {...actions} />
          <CardAction
            title={item.is_favorite ? "Unfavorite" : "Favorite"}
            active={item.is_favorite}
            onClick={() => actions.onFavorite(item.id)}
          >
            <Star
              className={`h-4 w-4 ${item.is_favorite ? "fill-amber-400 text-amber-400" : ""}`}
            />
          </CardAction>
          <CardAction
            title={item.is_archived ? "Unarchive" : "Archive"}
            onClick={() => actions.onArchive(item.id)}
          >
            {item.is_archived ? (
              <ArchiveRestore className="h-4 w-4" />
            ) : (
              <Archive className="h-4 w-4" />
            )}
          </CardAction>
        </div>
        <div className="aspect-video w-full overflow-hidden bg-muted">
          {item.thumbnail ? (
            <img
              src={item.thumbnail}
              alt=""
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Film className="h-8 w-8" />
            </div>
          )}
        </div>
        <div className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <PlatformBadge platform={item.platform} />
            <StatusBadge status={item.status} />
          </div>
          <h3 className="mb-2 line-clamp-2 font-medium leading-snug">
            {item.title || item.source_url}
          </h3>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {item.author && <span className="truncate">{item.author}</span>}
            <span>added {timeAgo(item.created_at)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {item.published_at && (
              <span className="flex items-center gap-1">
                <CalendarDays className="h-3 w-3" />
                {formatDate(item.published_at)}
              </span>
            )}
            {item.view_count != null && (
              <span className="flex items-center gap-1" title="Views at crawl time">
                <Eye className="h-3 w-3" />
                {formatCount(item.view_count)}
              </span>
            )}
            {item.like_count != null && (
              <span className="flex items-center gap-1" title="Likes at crawl time">
                <ThumbsUp className="h-3 w-3" />
                {formatCount(item.like_count)}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatMs(item.total_processing_ms)}
            </span>
            <span className="flex items-center gap-1">
              <Coins className="h-3 w-3" />
              {formatCost(item.total_cost_usd)}
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function FolderMenu({
  item,
  groups,
  onMove,
  onCreateFolderAndMove,
}: { item: Item } & Pick<ItemCardActions, "groups" | "onMove" | "onCreateFolderAndMove">) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const move = (groupId: number | null) => {
    onMove(item.id, groupId);
    close();
  };
  const createAndMove = () => {
    const title = window.prompt("New folder name")?.trim();
    if (title) onCreateFolderAndMove(item.id, title);
    close();
  };

  return (
    <>
      <CardAction
        title="Move to folder"
        active={item.group_id != null}
        onClick={() => setOpen((v) => !v)}
      >
        <FolderInput className="h-4 w-4" />
      </CardAction>
      {open && (
        <div
          className="fixed inset-0 z-40"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
        >
          <div
            className="absolute right-12 top-12 z-50 w-56 overflow-hidden rounded-md border border-border bg-card shadow-lg"
            style={{ position: "absolute" }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <div className="max-h-64 overflow-y-auto py-1">
              {item.group_id != null && (
                <MenuRow onClick={() => move(null)}>
                  <X className="h-4 w-4 text-muted-foreground" />
                  Remove from folder
                </MenuRow>
              )}
              {groups.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">No folders yet</p>
              )}
              {groups.map((g) => (
                <MenuRow key={g.id} onClick={() => move(g.id)}>
                  <span className="flex h-4 w-4 items-center justify-center">
                    {item.group_id === g.id && <Check className="h-4 w-4 text-primary" />}
                  </span>
                  <span className="truncate">{g.title || "Folder"}</span>
                </MenuRow>
              ))}
            </div>
            <button
              onClick={createAndMove}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm font-medium text-primary hover:bg-accent"
            >
              <FolderPlus className="h-4 w-4" />
              New folder…
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function MenuRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
    >
      {children}
    </button>
  );
}

export function CardAction({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={`rounded-md border border-border p-1.5 backdrop-blur transition-colors ${
        active
          ? "bg-background/90 text-amber-400"
          : "bg-background/70 text-muted-foreground hover:bg-background hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
