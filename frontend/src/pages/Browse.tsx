import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Film, Plus, Star } from "lucide-react";
import { api, type Item } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { Button, Card, Input, Select } from "@/components/ui";
import { PlatformBadge, StatusBadge, WaitingBadge } from "@/components/badges";
import { cn, formatCount } from "@/lib/utils";

const PLATFORMS = ["youtube", "bilibili", "apple_podcast", "xiaoyuzhou", "rss"];
const PAGE_SIZE = 60;
const SORTS = [
  { value: "priority", label: "Most requested" },
  { value: "added", label: "Recently added" },
  { value: "views", label: "Most views" },
  { value: "published", label: "Publish date" },
];

export function Browse() {
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("");
  const [sort, setSort] = useState("priority");
  const qc = useQueryClient();
  const me = useMe();
  const canAdd = !!me.data?.user;

  const items = useInfiniteQuery({
    queryKey: ["browse", { q, platform, sort }],
    queryFn: ({ pageParam }) =>
      api.browseItems({
        q: q || undefined,
        platform: platform || undefined,
        sort,
        order: "desc",
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.length === PAGE_SIZE ? all.length * PAGE_SIZE : undefined,
    refetchInterval: 10000,
  });

  const add = useMutation({
    mutationFn: (url: string) => api.addItems([url]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["browse"] });
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["queue"] });
    },
  });
  const interest = useMutation({
    mutationFn: (id: number) => api.toggleInterest(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["browse"] }),
  });

  const all = items.data?.pages.flat() ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Browse</h1>
          <p className="text-sm text-muted-foreground">
            Every episode anyone has added. Add one to your library to track it and
            build your knowledge graph.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={sort} onChange={(e) => setSort(e.target.value)} className="w-auto min-w-[140px]">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>
          <Input placeholder="Search titles..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <Chip label="All" active={!platform} onClick={() => setPlatform("")} />
        {PLATFORMS.map((p) => (
          <Chip key={p} label={p} active={platform === p} onClick={() => setPlatform(platform === p ? "" : p)} />
        ))}
      </div>

      {items.isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : all.length ? (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {all.map((item) => (
              <BrowseCard
                key={item.id}
                item={item}
                canAdd={canAdd}
                onAdd={() => add.mutate(item.source_url)}
                adding={add.isPending && add.variables === item.source_url}
                onInterest={() => interest.mutate(item.id)}
                interestPending={interest.isPending && interest.variables === item.id}
              />
            ))}
          </div>
          {items.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button variant="outline" onClick={() => items.fetchNextPage()} disabled={items.isFetchingNextPage}>
                {items.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      ) : (
        <Card className="p-10 text-center text-muted-foreground">
          Nothing here yet. Use "Add content" to ingest the first episode.
        </Card>
      )}
    </div>
  );
}

function BrowseCard({
  item,
  canAdd,
  onAdd,
  adding,
  onInterest,
  interestPending,
}: {
  item: Item;
  canAdd: boolean;
  onAdd: () => void;
  adding: boolean;
  onInterest: () => void;
  interestPending: boolean;
}) {
  return (
    <Card className="group relative flex h-full flex-col overflow-hidden transition-colors hover:border-primary">
      <Link to={`/items/${item.id}`} className="block">
        <div className="aspect-video w-full overflow-hidden bg-muted">
          {item.thumbnail ? (
            <img src={item.thumbnail} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Film className="h-8 w-8" />
            </div>
          )}
        </div>
      </Link>
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-2 flex items-center gap-2">
          <PlatformBadge platform={item.platform} />
          <StatusBadge status={item.status} />
          {item.personal_status === "waiting" && item.status !== "done" && <WaitingBadge />}
        </div>
        <Link to={`/items/${item.id}`} className="mb-2 line-clamp-2 font-medium leading-snug hover:underline">
          {item.title || item.source_url}
        </Link>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {item.author && <span className="truncate">{item.author}</span>}
          {item.view_count != null && <span>{formatCount(item.view_count)} views</span>}
          {item.request_count ? <span>{item.request_count} in libraries</span> : null}
          {item.interest_count ? <span>{item.interest_count} interested</span> : null}
        </div>
        <div className="mt-auto flex gap-2">
          {item.saved ? (
            <Button variant="outline" size="sm" disabled className="flex-1">
              <Check className="h-4 w-4" /> In your library
            </Button>
          ) : !canAdd ? (
            <Link to="/login" className="block flex-1">
              <Button variant="outline" size="sm" className="w-full">
                Sign in to add
              </Button>
            </Link>
          ) : (
            <Button size="sm" className="flex-1" onClick={onAdd} disabled={adding}>
              <Plus className="h-4 w-4" /> {adding ? "Adding…" : "Add to library"}
            </Button>
          )}
          {canAdd && (
            <Button
              variant="outline"
              size="sm"
              onClick={onInterest}
              disabled={interestPending}
              title={item.is_interested ? "You're interested — boosts processing priority" : "Mark interest to boost processing priority"}
            >
              <Star
                className={cn("h-4 w-4", item.is_interested && "fill-amber-400 text-amber-400")}
              />
              {!!item.interest_count && (
                <span className="text-xs text-muted-foreground">{item.interest_count}</span>
              )}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
        active ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent"
      }`}
    >
      {label.replace("_", " ")}
    </button>
  );
}
