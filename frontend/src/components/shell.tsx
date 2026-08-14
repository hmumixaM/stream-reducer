import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Button, Card, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { supportsInfiniteScroll, useInfiniteScroll } from "@/lib/useInfiniteScroll";

/**
 * Standalone "back" link. It retraces the last step whenever the visitor took
 * one inside the app; `to` and `label` only describe where a cold landing —
 * a shared URL, a new tab — should go instead.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  // react-router numbers its history entries; entry 0 is whatever the tab
  // showed before us, so only later entries have somewhere of ours to return to.
  const historyIndex = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  const canGoBack = historyIndex > 0 || location.key !== "default";

  return (
    <Link
      to={to}
      onClick={(event) => {
        if (!canGoBack || event.defaultPrevented) return;
        // Leave modified clicks alone so "open in new tab" still works.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(-1);
      }}
      className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> {canGoBack ? "Back" : label}
    </Link>
  );
}

/** Page-level header. Stacks on narrow screens so actions never crowd the title. */
export function PageHeader({
  title,
  subtitle,
  actions,
  backTo,
  backLabel,
  badges,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  backTo?: string;
  backLabel?: string;
  badges?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {backTo && <BackLink to={backTo} label={backLabel ?? "Back"} />}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words text-display font-semibold">{title}</h1>
            {badges}
          </div>
          {subtitle && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 md:shrink-0">{actions}</div>
        )}
      </div>
    </div>
  );
}

/** Horizontal control strip (search, selects, chips) above a list. */
export function Toolbar({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2 shadow-card",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  subtitle,
  actions,
  id,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
    </div>
  );
}

export function FilterChip({
  label,
  active,
  count,
  onClick,
}: {
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && (
        <span className={cn("tabular-nums", active ? "opacity-80" : "opacity-70")}>{count}</span>
      )}
    </button>
  );
}

/** Row of chips with consistent spacing (replaces per-page ad-hoc wrappers). */
export function ChipRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-4 flex flex-wrap gap-2", className)}>{children}</div>;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Card className="p-10 text-center">
      {icon && (
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <h3 className="font-medium">{title}</h3>
      {description && (
        <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </Card>
  );
}

export function ErrorState({
  message,
  onRetry,
  compact,
}: {
  message: ReactNode;
  onRetry?: () => void;
  /** Inline variant used at the infinite-scroll sentinel. */
  compact?: boolean;
}) {
  const body = (
    <>
      <p
        className={cn("text-sm text-danger", !compact && "mb-3")}
        role="alert"
        aria-live="polite"
      >
        {message}
      </p>
      {onRetry && (
        <Button
          size="sm"
          variant="outline"
          className={compact ? "shrink-0" : undefined}
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
    </>
  );
  if (compact) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-3 py-4">{body}</div>
    );
  }
  return <Card className="p-10 text-center">{body}</Card>;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <Card className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
      <Spinner /> {label}
    </Card>
  );
}

/** Inline text-only loading line for nested regions that shouldn't grow a card. */
export function LoadingLine({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Spinner /> {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse-soft rounded-md bg-muted", className)}
    />
  );
}

/** Placeholder shaped like an ItemCard (thumbnail + badges + two title lines). */
export function SkeletonCard() {
  return (
    <Card className="overflow-hidden">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </Card>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <ItemGrid>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </ItemGrid>
  );
}

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

/** The one grid geometry every card list uses. */
export function ItemGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", className)}>
      {children}
    </div>
  );
}

export function InfiniteScrollSentinel({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  disabled,
  error,
  variant = "grid",
  totalLabel,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  disabled?: boolean;
  /** Set when fetching the next page failed; shows a retry instead of retrying forever. */
  error?: Error | null;
  variant?: "grid" | "rows";
  /** Quiet "that's everything" line shown once the list is exhausted. */
  totalLabel?: ReactNode;
}) {
  const sentinelRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    disabled: disabled || Boolean(error),
  });

  if (!hasNextPage) {
    return totalLabel ? (
      <p className="mt-6 text-center text-xs text-muted-foreground">{totalLabel}</p>
    ) : null;
  }

  return (
    <div ref={sentinelRef} className="mt-4" aria-live="polite">
      {error ? (
        <ErrorState compact message={`Could not load more: ${error.message}`} onRetry={fetchNextPage} />
      ) : isFetchingNextPage ? (
        variant === "grid" ? (
          <SkeletonGrid count={4} />
        ) : (
          <SkeletonRows count={2} />
        )
      ) : !supportsInfiniteScroll ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={fetchNextPage}>
            Load more
          </Button>
        </div>
      ) : (
        <span className="sr-only">Loading more items as you scroll</span>
      )}
    </div>
  );
}

const MENU_WIDTH = 224; // w-56, needed up front to right-align the fixed panel.
const MENU_MAX_HEIGHT = 320;

/**
 * Overlay-backed dropdown shared by card menus. The panel is `fixed` and
 * anchored to the trigger's measured rect so it escapes the `overflow-hidden`
 * on the cards it usually lives inside.
 */
export function Menu({
  trigger,
  children,
  align = "right",
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align?: "left" | "right";
  label?: string;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const open = position !== null;
  const close = () => setPosition(null);

  const place = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const flipUp = rect.bottom + MENU_MAX_HEIGHT > window.innerHeight && rect.top > MENU_MAX_HEIGHT;
    const left = align === "right" ? rect.right - MENU_WIDTH : rect.left;
    setPosition({
      top: flipUp ? rect.top - 4 - MENU_MAX_HEIGHT : rect.bottom + 4,
      left: Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH - 8)),
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // The anchor moves with the page, so close rather than chase it.
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div ref={anchorRef} className="relative">
      {trigger({ open, toggle: () => (open ? close() : place()) })}
      {position && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              close();
            }}
          />
          <div
            role="menu"
            aria-label={label}
            style={{
              top: position.top,
              left: position.left,
              width: MENU_WIDTH,
              maxHeight: MENU_MAX_HEIGHT,
            }}
            className="fixed z-50 overflow-hidden rounded-md border border-border bg-card shadow-card-hover"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {children({ close })}
          </div>
        </>
      )}
    </div>
  );
}

export function MenuRow({
  onClick,
  children,
  variant = "default",
}: {
  onClick: () => void;
  children: ReactNode;
  variant?: "default" | "primary";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
        variant === "primary" && "border-t border-border font-medium text-primary",
      )}
    >
      {children}
    </button>
  );
}

/** Wraps long-form text pages so lines stay readable. */
export function TextColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("max-w-3xl", className)}>{children}</div>;
}

export function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
