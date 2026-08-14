import { Link } from "react-router-dom";
import { CalendarDays, Eye, Film, Plus } from "lucide-react";
import type { ChannelItemRead } from "@/lib/api";
import { Button, Card, Spinner } from "@/components/ui";
import { PlatformBadge, StatusBadge, WaitingBadge } from "@/components/badges";
import { ChannelByline } from "@/components/ChannelByline";
import { formatCount, formatDate } from "@/lib/utils";

/**
 * A catalog item the user has not saved yet. Deliberately mirrors `ItemCard`'s
 * padding and badge row so the two can sit side by side in one grid; the only
 * visual difference is the floating add button.
 */
export function CatalogItemCard({
  item,
  adding,
  onAdd,
  channel,
}: {
  item: ChannelItemRead;
  adding: boolean;
  onAdd: () => void;
  channel?: { id: number; title?: string | null } | null;
}) {
  return (
    <Card interactive className="group relative flex h-full flex-col overflow-hidden">
      <div className="absolute right-2 top-2 z-10">
        <Button
          size="sm"
          className="shadow-card"
          disabled={adding}
          aria-busy={adding}
          title="Add to library"
          onClick={onAdd}
        >
          {adding ? <Spinner /> : <Plus className="h-4 w-4" />}
          <span className="hidden sm:inline">{adding ? "Adding…" : "Add"}</span>
        </Button>
      </div>
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
          {item.personal_status === "waiting" && item.status !== "done" && <WaitingBadge />}
        </div>
        <Link
          to={`/items/${item.id}`}
          className="line-clamp-2 font-medium leading-snug hover:text-primary hover:underline"
        >
          {item.title || item.source_url}
        </Link>
        {channel && <ChannelByline id={channel.id} title={channel.title} />}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {item.author && <span className="truncate">{item.author}</span>}
          {item.published_at && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" />
              {formatDate(item.published_at)}
            </span>
          )}
          {item.view_count != null && (
            <span className="inline-flex items-center gap-1" title="Views at crawl time">
              <Eye className="h-3 w-3" />
              {formatCount(item.view_count)}
            </span>
          )}
        </div>
        <p className="mt-auto pt-3 text-xs text-muted-foreground">Not in your library yet</p>
      </div>
    </Card>
  );
}
