import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Radio, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { PlatformBadge } from "@/components/badges";
import { Button, Card, Select, Spinner, Switch } from "@/components/ui";
import { Menu, MenuRow } from "@/components/shell";
import {
  ChannelFollowControls,
  FollowStatusChip,
  invalidateChannelQueries,
} from "@/components/ChannelFollowControls";
import { api, type ChannelRead, type Group, type Subscription } from "@/lib/api";
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
        follow.follow_latest ? `every ${follow.interval_minutes}m` : "manual",
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
          {follow?.follow_latest && (
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

/**
 * A pre-channel-catalog follow, rendered in the same list so users manage one
 * set of rows. Settings stay read-only until the migration links it to a
 * channel; only the toggle, folder, poll, and unfollow actions work.
 */
export function LegacyFollowRow({
  subscription,
  groups,
}: {
  subscription: Subscription;
  groups: Group[];
}) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["subs"] }),
      queryClient.invalidateQueries({ queryKey: ["channels", "catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["channels", "following"] }),
    ]);
  const toggle = useMutation({
    mutationFn: () => api.toggleSubscription(subscription.id),
    onSuccess: refresh,
  });
  const updateFolder = useMutation({
    mutationFn: (folderId: number | null) =>
      api.updateSubscription(subscription.id, { folder_id: folderId }),
    onSuccess: refresh,
  });
  const poll = useMutation({
    mutationFn: () => api.pollSubscription(subscription.id),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSubscription(subscription.id),
    onSuccess: refresh,
  });
  const pending =
    toggle.isPending || updateFolder.isPending || poll.isPending || remove.isPending;
  const mutationError = toggle.error ?? updateFolder.error ?? poll.error ?? remove.error;
  const followsLatest = subscription.follow_latest ?? subscription.enabled;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Radio className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium">
              {subscription.title || subscription.feed_url}
            </span>
            <PlatformBadge platform={subscription.platform} />
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
              Awaiting migration
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[
              followsLatest ? `every ${subscription.interval_minutes}m` : "manual",
              `last ${subscription.window_days}d`,
              subscription.last_checked_at
                ? `checked ${timeAgo(subscription.last_checked_at)}`
                : "never checked",
            ].join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            title="Poll now"
            disabled={!followsLatest || pending}
            aria-busy={poll.isPending}
            onClick={() => poll.mutate()}
          >
            {poll.isPending ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
          </Button>
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
          <Menu
            label="Legacy follow options"
            trigger={({ toggle: openMenu }) => (
              <Button size="icon" variant="ghost" title="More options" onClick={openMenu}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          >
            {({ close }) => (
              <MenuRow
                onClick={() => {
                  close();
                  if (
                    window.confirm(
                      "Unfollow this channel? Existing library items will be kept.",
                    )
                  ) {
                    remove.mutate();
                  }
                }}
              >
                <Trash2 className="h-4 w-4 text-danger" /> Unfollow
              </MenuRow>
            )}
          </Menu>
        </div>
      </div>
      {subscription.last_error && !expanded && (
        <p className="border-t border-border px-3 py-2 text-xs text-danger">
          Last poll failed: {subscription.last_error}
        </p>
      )}
      {expanded && (
        <div className="space-y-3 border-t border-border bg-card-muted p-3">
          <Switch
            checked={followsLatest}
            disabled={pending}
            label="Follow latest"
            onCheckedChange={() => toggle.mutate()}
          />
          <label className="block max-w-xs text-xs font-medium text-muted-foreground">
            Folder
            <Select
              className="mt-1"
              value={subscription.folder_id != null ? String(subscription.folder_id) : ""}
              disabled={!followsLatest || pending}
              onChange={(event) =>
                updateFolder.mutate(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">Unfiled</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.title || "Folder"}
                </option>
              ))}
            </Select>
          </label>
          <p className="break-all text-xs text-muted-foreground">{subscription.feed_url}</p>
          {subscription.last_error && (
            <p className="break-words text-xs text-danger">
              Last poll failed: {subscription.last_error}
            </p>
          )}
          {mutationError && (
            <p className="text-sm text-danger" role="alert">
              {mutationError.message}
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
