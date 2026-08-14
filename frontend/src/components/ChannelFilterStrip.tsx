import { useState } from "react";
import { LayoutGrid, Radio } from "lucide-react";
import type { ChannelRead } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * A row of round channel avatars. Picking one narrows the page to that
 * channel; picking the leading "All" bubble clears the filter again.
 */
export function ChannelFilterStrip({
  channels,
  activeId,
  onSelect,
}: {
  channels: ChannelRead[];
  activeId: number | null;
  onSelect: (channelId: number | null) => void;
}) {
  if (channels.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Filter by channel"
      className="-mx-1 mb-4 flex gap-3 overflow-x-auto px-1 pb-1"
    >
      <AvatarButton label="All" active={activeId === null} onClick={() => onSelect(null)}>
        <LayoutGrid className="h-5 w-5" />
      </AvatarButton>
      {channels.map((channel) => {
        const name = channel.title || channel.feed_url;
        return (
          <AvatarButton
            key={channel.id}
            label={name}
            active={activeId === channel.id}
            onClick={() => onSelect(activeId === channel.id ? null : channel.id)}
          >
            <ChannelAvatar src={channel.image_url} name={name} />
          </AvatarButton>
        );
      })}
    </div>
  );
}

function AvatarButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className="group flex w-16 shrink-0 flex-col items-center gap-1.5 focus:outline-none"
    >
      <span
        className={cn(
          "flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground ring-2 ring-offset-2 ring-offset-background transition-colors group-focus-visible:ring-primary",
          active ? "ring-primary" : "ring-transparent group-hover:ring-border",
        )}
      >
        {children}
      </span>
      <span
        className={cn(
          "w-full truncate text-center text-[11px] leading-tight",
          active ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </button>
  );
}

function ChannelAvatar({ src, name }: { src?: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    const initial = name.trim().charAt(0).toUpperCase();
    return initial ? (
      <span className="text-lg font-semibold">{initial}</span>
    ) : (
      <Radio className="h-5 w-5" />
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className="h-full w-full object-cover"
    />
  );
}
