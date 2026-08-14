import { Badge } from "@/components/ui";
import type { ItemStatus, Platform } from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<ItemStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  fetching: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  transcribing: "bg-warning/15 text-warning",
  summarizing: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  done: "bg-success/15 text-success",
  error: "bg-danger/15 text-danger",
  excluded: "bg-muted text-muted-foreground",
};

// Terminal statuses don't show the pulsing "in-progress" dot.
const TERMINAL: ItemStatus[] = ["done", "error", "excluded"];

export function StatusBadge({ status }: { status: ItemStatus }) {
  return (
    <Badge className={cn(STATUS_STYLES[status])}>
      {!TERMINAL.includes(status) && (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status === "excluded" ? "members-only" : status}
    </Badge>
  );
}

// Shown when a shared item is still being processed for the current user's copy
// (the dedup payoff: the same content can sit "waiting" in several libraries).
export function WaitingBadge({ label = "waiting" }: { label?: string }) {
  return (
    <Badge className="bg-warning/15 text-warning" title="Shared content still processing — it'll appear once ready">
      <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      {label}
    </Badge>
  );
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: "YouTube",
  bilibili: "Bilibili",
  apple_podcast: "Apple Podcast",
  xiaoyuzhou: "小宇宙",
  rss: "RSS",
  unknown: "Link",
};

// Brand-ish hues, with a darker shade in light mode so they stay legible on white.
const PLATFORM_STYLES: Record<Platform, string> = {
  youtube: "bg-red-500/15 text-red-600 dark:text-red-400",
  bilibili: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  apple_podcast: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  xiaoyuzhou: "bg-pink-500/15 text-pink-600 dark:text-pink-400",
  rss: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  unknown: "bg-muted text-muted-foreground",
};

export function PlatformBadge({ platform }: { platform: Platform }) {
  return <Badge className={cn(PLATFORM_STYLES[platform])}>{PLATFORM_LABELS[platform]}</Badge>;
}
