import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Highlighter, MessageSquare } from "lucide-react";
import { api, type Annotation } from "@/lib/api";
import { Badge, Card, Spinner } from "@/components/ui";
import { PlatformBadge } from "@/components/badges";
import { hlClass } from "@/components/Highlightable";
import { timeAgo, cn } from "@/lib/utils";

type Filter = "all" | "highlight" | "comment";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "highlight", label: "Highlights" },
  { key: "comment", label: "Comments" },
];

export function Annotations() {
  const [filter, setFilter] = useState<Filter>("all");
  const all = useQuery({
    queryKey: ["annotations"],
    queryFn: () => api.listAnnotations(),
  });

  const rows = useMemo(() => {
    const data = all.data ?? [];
    if (filter === "all") return data;
    return data.filter((a) => a.kind === filter);
  }, [all.data, filter]);

  const counts = useMemo(() => {
    const data = all.data ?? [];
    return {
      highlight: data.filter((a) => a.kind === "highlight").length,
      comment: data.filter((a) => a.kind === "comment").length,
    };
  }, [all.data]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Highlights & notes</h1>
        <p className="text-sm text-muted-foreground">
          Every highlight and comment you've made, newest first. Click through to
          open the item where you made it.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-full px-3 py-1 text-sm font-medium transition-colors",
              filter === f.key
                ? "bg-primary text-primary-foreground"
                : "border border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
            {f.key === "highlight" && ` (${counts.highlight})`}
            {f.key === "comment" && ` (${counts.comment})`}
          </button>
        ))}
      </div>

      {all.isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> Loading…
        </div>
      )}
      {all.isError && (
        <Card className="p-6 text-center text-sm text-red-400">{String(all.error)}</Card>
      )}
      {all.isSuccess && rows.length === 0 && (
        <Card className="p-10 text-center text-muted-foreground">
          Nothing here yet. Select text in an item's summary or transcript to create
          a highlight, or leave a comment.
        </Card>
      )}

      <div className="space-y-3">
        {rows.map((a) => (
          <AnnotationCard key={`${a.kind}-${a.id}`} a={a} />
        ))}
      </div>
    </div>
  );
}

function AnnotationCard({ a }: { a: Annotation }) {
  const href = `/items/${a.item.id}`;
  const isHighlight = a.kind === "highlight";
  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PlatformBadge platform={a.item.platform} />
        {isHighlight ? (
          <Badge className="bg-amber-500/15 text-amber-400">
            <Highlighter className="mr-1 h-3 w-3" /> {a.source}
          </Badge>
        ) : (
          <Badge className="bg-sky-500/15 text-sky-400">
            <MessageSquare className="mr-1 h-3 w-3" /> comment
          </Badge>
        )}
        <span className="ml-auto">{timeAgo(a.created_at)}</span>
      </div>

      <Link to={href} className="text-sm font-medium hover:underline">
        {a.item.title || a.item.source_url}
      </Link>

      {isHighlight && a.quote && (
        <blockquote
          className={cn(
            "mt-2 whitespace-pre-wrap rounded-md border-l-2 border-border px-3 py-1.5 text-sm italic",
            hlClass(a.color),
          )}
        >
          “{a.quote}”
        </blockquote>
      )}

      {a.body && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{a.body}</p>
      )}

      <div className="mt-3 text-xs">
        <Link to={href} className="text-muted-foreground hover:underline">
          Open item →
        </Link>
      </div>
    </Card>
  );
}
