import { Link } from "react-router-dom";
import { Radio, Users } from "lucide-react";
import { PlatformBadge } from "@/components/badges";
import { Card } from "@/components/ui";
import {
  ChannelFollowControls,
  PollHealth,
} from "@/components/ChannelFollowControls";
import type { ChannelFollowRead, ChannelRead, Group } from "@/lib/api";
import { formatCount, formatDate, timeAgo } from "@/lib/utils";

/**
 * Expanded channel card with a recent-items preview. Used where a single
 * channel is the subject (the resolved URL preview); grids use the shorter
 * `ChannelTile` and the following list uses `ChannelRow`.
 */
export function ChannelCard({
  channel,
  groups,
  onFollowChanged,
}: {
  channel: ChannelRead;
  groups: Group[];
  onFollowChanged?: (follow: ChannelFollowRead | null) => void;
}) {
  const title = channel.title || channel.feed_url;
  const follow = channel.follow;

  return (
    <Card className="overflow-hidden">
      <div className="p-4">
        <div className="flex gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
            {channel.image_url ? (
              <img
                src={channel.image_url}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <Radio className="h-7 w-7" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <PlatformBadge platform={channel.platform} />
              {follow && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  Following
                </span>
              )}
            </div>
            <Link
              to={`/channels/${channel.id}`}
              className="line-clamp-2 font-semibold leading-snug hover:text-primary hover:underline"
            >
              {title}
            </Link>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" /> {formatCount(channel.follower_count)} followers
              </span>
              <span>{formatCount(channel.item_count)} items</span>
              {channel.latest_published_at && (
                <span>latest {timeAgo(channel.latest_published_at)}</span>
              )}
            </div>
          </div>
        </div>

        {channel.latest_items.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent items
            </p>
            <div className="space-y-2">
              {channel.latest_items.slice(0, 3).map((item) => (
                <Link
                  key={item.id}
                  to={`/items/${item.id}`}
                  className="flex items-center justify-between gap-3 text-sm hover:text-primary"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {item.title || item.headline || "Untitled item"}
                  </span>
                  {item.published_at && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(item.published_at)}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}

        {follow?.last_error && (
          <div className="mt-4">
            <PollHealth follow={follow} />
          </div>
        )}

        <div className="mt-4 border-t border-border pt-4">
          <ChannelFollowControls
            channelId={channel.id}
            follow={follow}
            groups={groups}
            onFollowChanged={onFollowChanged}
          />
        </div>
      </div>
    </Card>
  );
}
