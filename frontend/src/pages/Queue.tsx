import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { api, type QueueItem } from "@/lib/api";
import { Button, Card } from "@/components/ui";
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
      <h1 className="mb-1 text-2xl font-semibold">Queue</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {active.length} processing
        {stalled.length > 0 ? ` · ${stalled.length} stalled` : ""} · {failed.length} failed
        {queueTotal ? ` · ${queueTotal} item${queueTotal === 1 ? "" : "s"} pending site-wide` : ""}
      </p>

      {(stalled.length > 0 || failed.length > 0) && (
        <Card className="mb-6 flex items-start gap-3 border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="text-muted-foreground">
            {stalled.length > 0 && (
              <p>
                <span className="font-medium text-amber-400">{stalled.length} stalled</span>: a
                processing container was orphaned (usually a long item competing for limited
                container slots). These auto-restart up to 3 times, then need a manual retry.
              </p>
            )}
            {failed.length > 0 && (
              <p>
                <span className="font-medium text-red-400">{failed.length} failed</span>: see the
                error on each row. Repeated <code>503 no Container instance available</code> means
                the pipeline is at its concurrent-instance cap — retry once load clears.
              </p>
            )}
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">Queue is empty.</Card>
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
function phase(item: QueueItem): { label: string; tone: string } {
  if (item.status === "error") return { label: "failed", tone: "text-red-400" };
  if (item.stalled) return { label: "stalled — waiting to restart", tone: "text-amber-400" };
  if (item.status === "queued") return { label: "waiting in line", tone: "text-muted-foreground" };
  if (item.current_stage === "transcribe" && item.chunk_count > 0)
    return {
      label: `transcribing chunk ${item.chunk_done}/${item.chunk_count}`,
      tone: "text-amber-400",
    };
  if (item.current_stage === "download" || (item.status === "fetching" && !item.current_stage))
    return { label: "downloading audio", tone: "text-blue-400" };
  if (item.current_stage) return { label: item.current_stage, tone: "text-violet-400" };
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
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
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
        {item.error && <p className="mt-1 truncate text-xs text-red-400" title={item.error}>{item.error}</p>}
      </div>
      {(item.status === "error" || item.stalled) && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      )}
    </Card>
  );
}
