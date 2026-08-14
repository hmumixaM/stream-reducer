import { Link } from "react-router-dom";
import { Radio } from "lucide-react";

/**
 * Channel attribution under an item title, linking to the channel page. The
 * `relative z-10` keeps it clickable above `ItemCard`'s full-card link overlay.
 */
export function ChannelByline({ id, title }: { id: number; title?: string | null }) {
  return (
    <Link
      to={`/channels/${id}`}
      onClick={(event) => event.stopPropagation()}
      className="relative z-10 mt-1.5 inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
    >
      <Radio className="h-3 w-3 shrink-0" />
      <span className="truncate">{title || "Channel"}</span>
    </Link>
  );
}
