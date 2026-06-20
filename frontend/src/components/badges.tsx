import { Badge } from "@/components/ui";
import type { ItemStatus, Platform } from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<ItemStatus, string> = {
  queued: "bg-slate-500/15 text-slate-400",
  fetching: "bg-blue-500/15 text-blue-400",
  transcribing: "bg-amber-500/15 text-amber-400",
  summarizing: "bg-violet-500/15 text-violet-400",
  done: "bg-emerald-500/15 text-emerald-400",
  error: "bg-red-500/15 text-red-400",
  excluded: "bg-slate-500/15 text-slate-400",
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
    <Badge className="bg-amber-500/15 text-amber-400" title="Shared content still processing — it'll appear once ready">
      <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      {label}
    </Badge>
  );
}

const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: "YouTube",
  bilibili: "Bilibili",
  apple_podcast: "Apple Podcast",
  xiaoyuzhou: "小宇宙",
  rss: "RSS",
  unknown: "Link",
};

const PLATFORM_STYLES: Record<Platform, string> = {
  youtube: "bg-red-500/15 text-red-400",
  bilibili: "bg-sky-500/15 text-sky-400",
  apple_podcast: "bg-purple-500/15 text-purple-400",
  xiaoyuzhou: "bg-pink-500/15 text-pink-400",
  rss: "bg-orange-500/15 text-orange-400",
  unknown: "bg-slate-500/15 text-slate-400",
};

export function PlatformBadge({ platform }: { platform: Platform }) {
  return <Badge className={cn(PLATFORM_STYLES[platform])}>{PLATFORM_LABELS[platform]}</Badge>;
}
