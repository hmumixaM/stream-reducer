import { Link } from "react-router-dom";
import { Radio, Users } from "lucide-react";
import { PlatformBadge } from "@/components/badges";
import { Card } from "@/components/ui";
import { ChannelFollowControls } from "@/components/ChannelFollowControls";
import type { ChannelFollowRead, ChannelRead, Group } from "@/lib/api";
import { cn, formatCount, timeAgo } from "@/lib/utils";

/**
 * Scannable channel card for the Discover grid. Recent items and follow
 * settings deliberately live only on the preview and detail views, keeping the
 * tile short enough that a screen shows a dozen channels instead of two.
 */
export function ChannelTile({
  channel,
  groups,
  highlighted = false,
  onFollowChanged,
}: {
  channel: ChannelRead;
  groups: Group[];
  /** Set for the just-resolved preview channel so it reads as the new arrival. */
  highlighted?: boolean;
  onFollowChanged?: (follow: ChannelFollowRead | null) => void;
}) {
  const title = channel.title || channel.feed_url;

  return (
    <Card
      className={cn(
        "flex h-full flex-col gap-3 p-4",
        highlighted && "border-primary ring-1 ring-primary",
      )}
    >
      <div className="flex gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
          {channel.image_url ? (
            <img
              src={channel.image_url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <Radio className="h-6 w-6" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {/* Follow state is already carried by the button below, so the header
              stays a single badge row and titles line up across the grid. */}
          <div className="mb-1">
            <PlatformBadge platform={channel.platform} />
          </div>
          <Link
            to={`/channels/${channel.id}`}
            className="line-clamp-2 font-semibold leading-snug hover:text-primary hover:underline"
          >
            {title}
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3 w-3" /> {formatCount(channel.follower_count)}
        </span>
        <span>{formatCount(channel.item_count)} items</span>
        {channel.latest_published_at && <span>latest {timeAgo(channel.latest_published_at)}</span>}
      </div>

      <div className="mt-auto flex justify-end pt-1">
        <ChannelFollowControls
          compact
          channelId={channel.id}
          follow={channel.follow}
          groups={groups}
          onFollowChanged={onFollowChanged}
        />
      </div>
    </Card>
  );
}
