import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
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
  const active = items.filter((i) => i.status !== "error");
  const failed = items.filter((i) => i.status === "error");
  const queueTotal = items.find((i) => i.queue_total != null)?.queue_total;

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Queue</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {active.length} processing · {failed.length} failed
        {queueTotal ? ` · ${queueTotal} item${queueTotal === 1 ? "" : "s"} pending site-wide` : ""}
      </p>

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

function QueueRow({ item, onRetry }: { item: QueueItem; onRetry: () => void }) {
  const elapsed = item.started_at
    ? timeAgo(item.started_at)
    : timeAgo(item.enqueued_at);
  const progress =
    item.current_stage === "transcribe" && item.chunk_count > 0
      ? `transcribing chunk ${item.chunk_done}/${item.chunk_count}`
      : item.current_stage
        ? item.current_stage
        : item.status;
  // Show the position only while still waiting in line (not actively running).
  const waiting = item.status === "queued" && item.queue_position != null;

  return (
    <Card className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <PlatformBadge platform={item.platform} />
          <StatusBadge status={item.status} />
          {waiting && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              #{item.queue_position}{item.queue_total ? ` of ${item.queue_total}` : ""} in line
            </span>
          )}
        </div>
        <Link to={`/items/${item.id}`} className="block truncate font-medium hover:underline">
          {item.title || item.source_url}
        </Link>
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="capitalize">{progress}</span>
          <span>started {elapsed}</span>
          {item.total_api_requests > 0 && <span>{item.total_api_requests} req</span>}
          {item.total_tokens > 0 && <span>{item.total_tokens.toLocaleString()} tok</span>}
        </div>
        {item.error && <p className="mt-1 truncate text-xs text-red-400">{item.error}</p>}
      </div>
      {item.status === "error" && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      )}
    </Card>
  );
}
