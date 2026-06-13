import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RefreshCw, Trash2, Power } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { PlatformBadge } from "@/components/badges";
import { timeAgo } from "@/lib/utils";

export function Subscriptions() {
  const qc = useQueryClient();
  const [feed, setFeed] = useState("");
  const [interval, setIntervalMin] = useState("60");
  const [windowDays, setWindowDays] = useState("90");

  const subs = useQuery({ queryKey: ["subs"], queryFn: api.listSubscriptions });
  const add = useMutation({
    mutationFn: () =>
      api.addSubscription(feed.trim(), Number(interval) || 60, Number(windowDays) || 90),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subs"] });
      setFeed("");
    },
  });
  const toggle = useMutation({
    mutationFn: (id: number) => api.toggleSubscription(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subs"] }),
  });
  const poll = useMutation({ mutationFn: (id: number) => api.pollSubscription(id) });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteSubscription(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subs"] }),
  });
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Subscriptions</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        RSS / RSSHub feeds and YouTube channel feeds are polled automatically.
        New subscriptions backfill videos from the last 3 months by default.
      </p>

      <Card className="mb-6 p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (feed.trim()) add.mutate();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="flex-1">
            <label className="mb-1 block text-xs text-muted-foreground">Feed or channel URL</label>
            <Input
              placeholder="https://www.youtube.com/channel/... or https://rsshub.app/youtube/channel/..."
              value={feed}
              onChange={(e) => setFeed(e.target.value)}
            />
          </div>
          <div className="w-28">
            <label className="mb-1 block text-xs text-muted-foreground">Every (min)</label>
            <Input
              type="number"
              value={interval}
              onChange={(e) => setIntervalMin(e.target.value)}
            />
          </div>
          <div className="w-32">
            <label className="mb-1 block text-xs text-muted-foreground">Backfill (days)</label>
            <Input
              type="number"
              min={1}
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
              title="Only ingest videos published within this many days (default 90 = last 3 months)"
            />
          </div>
          <Button type="submit" disabled={add.isPending || !feed.trim()}>
            {add.isPending ? <Spinner /> : "Subscribe"}
          </Button>
        </form>
        {add.isError && <p className="mt-2 text-sm text-red-400">{String(add.error)}</p>}
      </Card>

      <div className="space-y-3">
        {(subs.data ?? []).map((s) => (
          <Card key={s.id} className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <PlatformBadge platform={s.platform} />
                  {!s.enabled && (
                    <span className="text-xs text-muted-foreground">paused</span>
                  )}
                </div>
                <button
                  className="truncate text-left font-medium hover:underline"
                  onClick={() => setOpenId(openId === s.id ? null : s.id)}
                >
                  {s.title || s.feed_url}
                </button>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>every {s.interval_minutes}m</span>
                  {s.window_days != null && <span>last {s.window_days}d</span>}
                  <span>
                    {s.last_checked_at
                      ? `checked ${timeAgo(s.last_checked_at)}`
                      : "never checked"}
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => poll.mutate(s.id)}>
                  <RefreshCw className="h-4 w-4" /> Poll
                </Button>
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(s.id)}>
                  <Power className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="danger" onClick={() => remove.mutate(s.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {openId === s.id && <SubscriptionDetails id={s.id} />}
          </Card>
        ))}
        {subs.data?.length === 0 && (
          <Card className="p-10 text-center text-muted-foreground">
            No subscriptions yet.
          </Card>
        )}
      </div>
    </div>
  );
}

function SubscriptionDetails({ id }: { id: number }) {
  const [comment, setComment] = useState("");
  const qc = useQueryClient();
  const items = useQuery({
    queryKey: ["sub-items", id],
    queryFn: () => api.listSubscriptionItems(id),
  });
  const annotations = useQuery({
    queryKey: ["sub-annotations", id],
    queryFn: () => api.listSubscriptionAnnotations(id),
  });
  const addComment = useMutation({
    mutationFn: () => api.addSubscriptionComment(id, comment.trim()),
    onSuccess: () => {
      setComment("");
      qc.invalidateQueries({ queryKey: ["sub-annotations", id] });
    },
  });

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-3">
        <h3 className="mb-2 text-sm font-semibold">Subscribed episodes</h3>
        <div className="space-y-1 text-sm">
          {(items.data ?? []).slice(0, 8).map((item) => (
            <Link key={item.id} to={`/items/${item.id}`} className="block truncate text-muted-foreground hover:text-foreground hover:underline">
              {item.title || item.source_url}
            </Link>
          ))}
          {items.isSuccess && items.data.length === 0 && (
            <p className="text-muted-foreground">No episodes have been added from this subscription yet.</p>
          )}
        </div>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (comment.trim()) addComment.mutate();
        }}
      >
        <Input
          placeholder="Add a note about this subscription..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <Button type="submit" disabled={!comment.trim() || addComment.isPending}>Comment</Button>
      </form>
      {(annotations.data ?? []).length > 0 && (
        <div className="mt-3 space-y-2 text-sm">
          {(annotations.data ?? []).map((row) => (
            <p key={`${row.kind}-${row.id}`} className="rounded-md bg-muted px-3 py-2 text-muted-foreground">
              {String(row.body || row.quote || "")}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
