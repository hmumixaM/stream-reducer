import { useEffect, useId, useState } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  Check,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import {
  api,
  type ChannelFollowRead,
  type Group,
} from "@/lib/api";
import { Button, Input, Select, Spinner, Switch } from "@/components/ui";
import { Menu, MenuRow } from "@/components/shell";
import { timeAgo } from "@/lib/utils";

export function invalidateChannelQueries(queryClient: QueryClient, channelId: number) {
  queryClient.invalidateQueries({ queryKey: ["channels", "catalog"] });
  queryClient.invalidateQueries({ queryKey: ["channels", "following"] });
  queryClient.invalidateQueries({ queryKey: ["channel", channelId] });
  queryClient.invalidateQueries({ queryKey: ["channel", channelId, "items"] });
  queryClient.invalidateQueries({ queryKey: ["subs"] });
  queryClient.invalidateQueries({ queryKey: ["timeline"] });
}

/**
 * Follow state for one channel: the follow/unfollow buttons plus an optional
 * settings panel. The panel is *controlled* — the compact tile never opens it,
 * while `ChannelRow` and the detail page expand it on demand — so a grid of
 * channels is no longer padded out by three always-visible form fields.
 */
export function ChannelFollowControls({
  channelId,
  follow,
  groups,
  settingsOpen = false,
  showToggle = true,
  compact = false,
  onFollowChanged,
}: {
  channelId: number;
  follow: ChannelFollowRead | null;
  groups: Group[];
  settingsOpen?: boolean;
  /** False when the toggle is rendered elsewhere and this instance is settings-only. */
  showToggle?: boolean;
  /** Tile mode: a single primary action plus an overflow menu, no inline forms. */
  compact?: boolean;
  onFollowChanged?: (follow: ChannelFollowRead | null) => void;
}) {
  const queryClient = useQueryClient();
  const instanceId = useId();
  const latestSettingsId = `${instanceId}-latest-settings`;
  const intervalHelpId = `${instanceId}-interval-help`;
  const [showLatestSetup, setShowLatestSetup] = useState(false);
  const [folderId, setFolderId] = useState("");
  const [windowDays, setWindowDays] = useState("90");
  const [intervalMinutes, setIntervalMinutes] = useState("60");

  useEffect(() => {
    setFolderId(follow?.folder_id != null ? String(follow.folder_id) : "");
    setWindowDays(String(follow?.window_days ?? 90));
    setIntervalMinutes(String(follow?.interval_minutes ?? 60));
  }, [follow]);

  const refresh = (next: ChannelFollowRead | null) => {
    invalidateChannelQueries(queryClient, channelId);
    onFollowChanged?.(next);
  };

  const followChannel = useMutation({
    mutationFn: (followLatest: boolean) =>
      api.followChannel(
        channelId,
        followLatest
          ? {
              follow_latest: true,
              folder_id: folderId ? Number(folderId) : null,
              window_days: Number(windowDays),
              interval_minutes: Number(intervalMinutes),
            }
          : { follow_latest: false },
      ),
    onSuccess: (next) => {
      setShowLatestSetup(false);
      refresh(next);
    },
  });
  const update = useMutation({
    mutationFn: (payload: Parameters<typeof api.updateChannelFollow>[1]) =>
      api.updateChannelFollow(channelId, payload),
    onSuccess: refresh,
  });
  const unfollow = useMutation({
    mutationFn: () => api.unfollowChannel(channelId),
    onSuccess: () => refresh(null),
  });
  const poll = useMutation({
    mutationFn: () => api.pollChannel(channelId),
    onSuccess: () => invalidateChannelQueries(queryClient, channelId),
  });

  const mutationError =
    followChannel.error ?? update.error ?? unfollow.error ?? poll.error;
  const pending =
    followChannel.isPending || update.isPending || unfollow.isPending || poll.isPending;
  const confirmUnfollow = () => {
    if (window.confirm("Unfollow this channel? Existing library items will be kept.")) {
      unfollow.mutate();
    }
  };

  if (!follow) {
    return (
      <div className="space-y-3" onClick={(event) => event.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={compact ? "default" : "outline"}
            disabled={pending}
            aria-busy={followChannel.isPending}
            onClick={() => followChannel.mutate(false)}
          >
            {followChannel.isPending ? <Spinner /> : <Plus className="h-4 w-4" />}
            Follow
          </Button>
          {compact ? (
            <Menu
              label="More follow options"
              trigger={({ toggle }) => (
                <Button size="icon" variant="outline" title="More options" onClick={toggle}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              )}
            >
              {({ close }) => (
                <MenuRow
                  onClick={() => {
                    followChannel.mutate(true);
                    close();
                  }}
                >
                  <Zap className="h-4 w-4 text-primary" />
                  Follow latest…
                </MenuRow>
              )}
            </Menu>
          ) : (
            <Button
              size="sm"
              disabled={pending}
              aria-expanded={showLatestSetup}
              aria-controls={latestSettingsId}
              onClick={() => setShowLatestSetup((open) => !open)}
            >
              Follow latest
            </Button>
          )}
        </div>
        {!compact && showLatestSetup && (
          <form
            id={latestSettingsId}
            className="rounded-md border border-border bg-card-muted p-3"
            onSubmit={(event) => {
              event.preventDefault();
              followChannel.mutate(true);
            }}
          >
            <FollowSettings
              intervalHelpId={intervalHelpId}
              groups={groups}
              folderId={folderId}
              windowDays={windowDays}
              intervalMinutes={intervalMinutes}
              onFolderChange={setFolderId}
              onWindowChange={setWindowDays}
              onIntervalChange={setIntervalMinutes}
            />
            <Button
              className="mt-3"
              size="sm"
              type="submit"
              disabled={pending}
              aria-busy={followChannel.isPending}
            >
              {followChannel.isPending ? (
                <>
                  <Spinner /> Following latest…
                </>
              ) : (
                "Confirm follow latest"
              )}
            </Button>
          </form>
        )}
        {mutationError && <MutationError error={mutationError} />}
      </div>
    );
  }

  if (compact) {
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <Button size="sm" variant="outline" disabled className="pointer-events-none">
          <Check className="h-4 w-4" /> Following
        </Button>
        <Menu
          label="Follow options"
          trigger={({ toggle }) => (
            <Button size="icon" variant="outline" title="Follow options" onClick={toggle}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          )}
        >
          {({ close }) => (
            <>
              <MenuRow
                onClick={() => {
                  update.mutate({ follow_latest: !follow.follow_latest });
                  close();
                }}
              >
                <Zap
                  className={follow.follow_latest ? "h-4 w-4 text-primary" : "h-4 w-4 text-muted-foreground"}
                />
                {follow.follow_latest ? "Stop auto-updates" : "Follow latest…"}
              </MenuRow>
              <MenuRow
                onClick={() => {
                  close();
                  confirmUnfollow();
                }}
              >
                <Trash2 className="h-4 w-4 text-danger" />
                Unfollow
              </MenuRow>
            </>
          )}
        </Menu>
        {mutationError && <MutationError error={mutationError} />}
      </div>
    );
  }

  return (
    <div className="space-y-3" onClick={(event) => event.stopPropagation()}>
      {showToggle && (
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={follow.follow_latest}
            disabled={pending}
            label="Follow latest"
            onCheckedChange={(checked) => update.mutate({ follow_latest: checked })}
          />
          {!follow.follow_latest && (
            <span className="text-xs text-muted-foreground">
              Following without automatic updates
            </span>
          )}
        </div>
      )}

      {settingsOpen && (
        <>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate({
                folder_id: folderId ? Number(folderId) : null,
                window_days: Number(windowDays),
                interval_minutes: Number(intervalMinutes),
              });
            }}
          >
            <fieldset disabled={!follow.follow_latest || pending}>
              <FollowSettings
                intervalHelpId={intervalHelpId}
                groups={groups}
                folderId={folderId}
                windowDays={windowDays}
                intervalMinutes={intervalMinutes}
                onFolderChange={setFolderId}
                onWindowChange={setWindowDays}
                onIntervalChange={setIntervalMinutes}
              />
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                type="submit"
                aria-busy={update.isPending}
              >
                {update.isPending ? (
                  <>
                    <Spinner /> Saving…
                  </>
                ) : (
                  "Save settings"
                )}
              </Button>
            </fieldset>
            {!follow.follow_latest && (
              <p className="text-xs text-muted-foreground">
                Folder, backfill window, and polling interval apply only when automatic
                updates are enabled.
              </p>
            )}
          </form>
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button
              size="sm"
              variant="outline"
              disabled={!follow.follow_latest || pending}
              aria-busy={poll.isPending}
              onClick={() => poll.mutate()}
            >
              {poll.isPending ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
              Poll now
            </Button>
            <Button size="sm" variant="danger" disabled={pending} onClick={confirmUnfollow}>
              <Trash2 className="h-4 w-4" /> Unfollow
            </Button>
          </div>
        </>
      )}
      {mutationError && <MutationError error={mutationError} />}
    </div>
  );
}

/** Compact status pill summarising the last poll of a follow. */
export function FollowStatusChip({ follow }: { follow: ChannelFollowRead }) {
  if (!follow.follow_latest) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        paused
      </span>
    );
  }
  const tone =
    follow.last_status === "error"
      ? "bg-danger/15 text-danger"
      : follow.last_status === "empty"
        ? "bg-warning/15 text-warning"
        : "bg-success/15 text-success";
  const label =
    follow.last_status === "error"
      ? `error${follow.consecutive_failures ? ` ×${follow.consecutive_failures}` : ""}`
      : follow.last_status === "empty"
        ? "no entries"
        : follow.last_new_count
          ? `+${follow.last_new_count} new`
          : "ok";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
  );
}

export function PollHealth({ follow }: { follow: ChannelFollowRead }) {
  return (
    <div className="rounded-md bg-card-muted p-3 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {follow.last_checked_at
            ? `Checked ${timeAgo(follow.last_checked_at)}`
            : "Never checked"}
        </span>
        {follow.last_status && <FollowStatusChip follow={follow} />}
      </div>
      {follow.last_error && (
        <p className="mt-2 break-words text-danger">Last poll failed: {follow.last_error}</p>
      )}
    </div>
  );
}

function FollowSettings({
  intervalHelpId,
  groups,
  folderId,
  windowDays,
  intervalMinutes,
  onFolderChange,
  onWindowChange,
  onIntervalChange,
}: {
  intervalHelpId: string;
  groups: Group[];
  folderId: string;
  windowDays: string;
  intervalMinutes: string;
  onFolderChange: (value: string) => void;
  onWindowChange: (value: string) => void;
  onIntervalChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="block text-xs font-medium text-muted-foreground">
        Folder
        <Select
          name="folder_id"
          className="mt-1"
          value={folderId}
          onChange={(event) => onFolderChange(event.target.value)}
        >
          <option value="">Unfiled</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.title || "Folder"}
            </option>
          ))}
        </Select>
      </label>
      <label className="block text-xs font-medium text-muted-foreground">
        Backfill days
        <Input
          name="window_days"
          className="mt-1"
          type="number"
          inputMode="numeric"
          min={1}
          max={3650}
          required
          value={windowDays}
          onChange={(event) => onWindowChange(event.target.value)}
        />
      </label>
      <label className="block text-xs font-medium text-muted-foreground">
        Every (minutes)
        <Input
          name="interval_minutes"
          className="mt-1"
          type="number"
          inputMode="numeric"
          min={15}
          max={10080}
          required
          value={intervalMinutes}
          onChange={(event) => onIntervalChange(event.target.value)}
          aria-describedby={intervalHelpId}
        />
        <span id={intervalHelpId} className="sr-only">
          Polling interval in minutes
        </span>
      </label>
    </div>
  );
}

function MutationError({ error }: { error: Error }) {
  return (
    <p className="text-sm text-danger" role="alert" aria-live="polite">
      {error.message}
    </p>
  );
}
