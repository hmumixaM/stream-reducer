import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, AlertTriangle, ListChecks } from "lucide-react";
import { api, type QueueItem } from "@/lib/api";
import { Button, Card } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonRows,
} from "@/components/shell";
import { PlatformBadge, StatusBadge } from "@/components/badges";
import { timeAgo } from "@/lib/utils";

export function Queue() {
  const qc = useQueryClient();
  const queue = useQuery({
    queryKey: ["queue"],
    queryFn: api.listQueue,
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: (id: number) => api.retryItem(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  });

  const items = queue.data ?? [];
  const failed = items.filter((i) => i.status === "error");
  const stalled = items.filter((i) => i.status !== "error" && i.stalled);
  const active = items.filter((i) => i.status !== "error" && !i.stalled);
  const queueTotal = items.find((i) => i.queue_total != null)?.queue_total;

  return (
    <div>
      <PageHeader
        title="Queue"
        subtitle={
          <>
            {active.length} processing
            {stalled.length > 0 ? ` · ${stalled.length} stalled` : ""} · {failed.length} failed
            {queueTotal
              ? ` · ${queueTotal} item${queueTotal === 1 ? "" : "s"} pending site-wide`
              : ""}
          </>
        }
      />

      {(stalled.length > 0 || failed.length > 0) && (
        <Card className="mb-6 flex items-start gap-3 border-warning/30 bg-warning/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="space-y-1 text-muted-foreground">
            {stalled.length > 0 && (
              <p>
                <span className="font-medium text-warning">{stalled.length} stalled</span>: a
                processing container was orphaned (usually a long item competing for limited
                container slots). These auto-restart up to 3 times, then need a manual retry.
              </p>
            )}
            {failed.length > 0 && (
              <p>
                <span className="font-medium text-danger">{failed.length} failed</span>: see the
                error on each row. Repeated <code>503 no Container instance available</code> means
                the pipeline is at its concurrent-instance cap — retry once load clears.
              </p>
            )}
          </div>
        </Card>
      )}

      {queue.isLoading ? (
        <SkeletonRows count={3} />
      ) : queue.isError ? (
        <ErrorState message={queue.error.message} onRetry={() => queue.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="h-5 w-5" />}
          title="Queue is empty"
          description="Nothing is processing right now. Add a link from Saved or follow a channel to keep it fed."
        />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <QueueRow key={item.id} item={item} onRetry={() => retry.mutate(item.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Human-readable phase + the tone to color it with, derived from the raw status,
// the current pipeline stage, and whether the run has stalled.
const TONE = {
  download: "text-sky-600 dark:text-sky-400",
  work: "text-violet-600 dark:text-violet-400",
} as const;

function phase(item: QueueItem): { label: string; tone: string } {
  if (item.status === "error") return { label: "failed", tone: "text-danger" };
  if (item.stalled) return { label: "stalled — waiting to restart", tone: "text-warning" };
  if (item.status === "queued") return { label: "waiting in line", tone: "text-muted-foreground" };
  // Prefer the live progress heartbeat; fall back to the post-hoc stage_run.
  const stage = item.progress_stage || item.current_stage;
  const detail = item.progress_detail;
  if (stage === "download")
    return { label: detail ? `downloading · ${detail}` : "downloading audio", tone: TONE.download };
  if (stage === "transcribe") {
    const d = detail || (item.chunk_count > 0 ? `chunk ${item.chunk_done}/${item.chunk_count}` : "");
    return { label: d ? `transcribing · ${d}` : "transcribing", tone: "text-warning" };
  }
  if (stage === "summarize") return { label: "summarizing", tone: TONE.work };
  if (item.status === "fetching") return { label: "downloading audio", tone: TONE.download };
  if (stage) return { label: stage, tone: TONE.work };
  return { label: item.status, tone: "text-muted-foreground" };
}

function QueueRow({ item, onRetry }: { item: QueueItem; onRetry: () => void }) {
  const since = item.started_at ?? item.enqueued_at;
  const sinceLabel = item.started_at ? "started" : "queued";
  const { label, tone } = phase(item);
  const waiting = item.status === "queued" && item.queue_position != null;

  return (
    <Card className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <PlatformBadge platform={item.platform} />
          <StatusBadge status={item.status} />
          {waiting && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              #{item.queue_position}{item.queue_total ? ` of ${item.queue_total}` : ""} in line
            </span>
          )}
          {item.stalled && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
              stalled
            </span>
          )}
          {item.retry_count > 0 && (
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
              title="Number of failed/orphaned attempts so far"
            >
              {item.retry_count}× attempt{item.retry_count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <Link to={`/items/${item.id}`} className="block truncate font-medium hover:underline">
          {item.title || item.source_url}
        </Link>
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className={`font-medium ${tone}`}>{label}</span>
          <span>
            {sinceLabel} {timeAgo(since)}
          </span>
          {item.total_api_requests > 0 && <span>{item.total_api_requests} req</span>}
          {item.total_tokens > 0 && <span>{item.total_tokens.toLocaleString()} tok</span>}
        </div>
        {item.progress_pct != null && item.status !== "error" && !item.stalled && (
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, Math.max(0, item.progress_pct))}%` }}
            />
          </div>
        )}
        {item.error && (
          <p className="mt-1 truncate text-xs text-danger" title={item.error}>
            {item.error}
          </p>
        )}
      </div>
      {(item.status === "error" || item.stalled) && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      )}
    </Card>
  );
}
