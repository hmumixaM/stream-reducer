import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Radio, RefreshCw, Settings2 } from "lucide-react";
import { PlatformBadge } from "@/components/badges";
import { Button, Card, Spinner } from "@/components/ui";
import {
  ChannelFollowControls,
  FollowStatusChip,
  invalidateChannelQueries,
} from "@/components/ChannelFollowControls";
import { api, type ChannelRead, type Group } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";

/**
 * One followed channel per row: identity, poll health, and the actions you
 * actually reach for. The three settings fields stay collapsed until asked for,
 * which is what lets ~15 follows fit on a screen instead of two.
 */
export function ChannelRow({
  channel,
  groups,
  onPoll,
}: {
  channel: ChannelRead;
  groups: Group[];
  /** Lets the page tighten its refetch interval while a poll is in flight. */
  onPoll?: (pending: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const follow = channel.follow;
  const poll = useMutation({
    mutationFn: () => api.pollChannel(channel.id),
    onMutate: () => onPoll?.(true),
    onSettled: () => {
      onPoll?.(false);
      invalidateChannelQueries(queryClient, channel.id);
    },
  });

  const meta = follow
    ? [
        `every ${follow.interval_minutes}m`,
        `last ${follow.window_days}d`,
        follow.last_checked_at ? `checked ${timeAgo(follow.last_checked_at)}` : "never checked",
        folderLabel(groups, follow.folder_id),
      ].filter(Boolean)
    : [];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
          {channel.image_url ? (
            <img src={channel.image_url} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <Radio className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              to={`/channels/${channel.id}`}
              className="truncate font-medium hover:text-primary hover:underline"
            >
              {channel.title || channel.feed_url}
            </Link>
            <PlatformBadge platform={channel.platform} />
            {follow && <FollowStatusChip follow={follow} />}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta.join(" · ")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {follow && (
            <Button
              size="icon"
              variant="ghost"
              title="Poll now"
              aria-busy={poll.isPending}
              disabled={poll.isPending}
              onClick={() => poll.mutate()}
            >
              {poll.isPending ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            title="Follow settings"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            <Settings2 className="h-4 w-4" />
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
            />
          </Button>
        </div>
      </div>
      {follow?.last_error && !expanded && (
        <p className="border-t border-border px-3 py-2 text-xs text-danger">
          Last poll failed: {follow.last_error}
        </p>
      )}
      {expanded && (
        <div className="border-t border-border bg-card-muted p-3">
          <ChannelFollowControls
            settingsOpen
            showFollowButton={false}
            channelId={channel.id}
            follow={follow}
            groups={groups}
          />
          {follow?.last_error && (
            <p className="mt-3 break-words text-xs text-danger">
              Last poll failed: {follow.last_error}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function folderLabel(groups: Group[], folderId: number | null): string {
  if (folderId == null) return "unfiled";
  return groups.find((group) => group.id === folderId)?.title || "folder";
}
