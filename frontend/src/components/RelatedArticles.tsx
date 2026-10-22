import { ReaderLink as Link } from "@/components/Reader";
import { useQuery } from "@tanstack/react-query";
import { Film, Network, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import { PlatformBadge } from "@/components/badges";

/** Recommendation grid shown at the bottom of an article. Works live (REST) and
 * in the static mirror (related list embedded in the item JSON). */
export function RelatedArticles({ itemId }: { itemId: number }) {
  const related = useQuery({
    queryKey: ["related", itemId],
    queryFn: () => api.getRelated(itemId),
  });

  const items = related.data ?? [];
  if (related.isLoading || items.length === 0) return null;

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-primary" /> Related articles
        </h2>
        <Link
          to={`/graph?focus=${itemId}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Network className="h-3.5 w-3.5" /> View in graph
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <Link key={it.item_id} to={`/items/${it.item_id}`}>
            <Card className="group flex h-full gap-3 overflow-hidden p-2 transition-colors hover:border-primary">
              <div className="aspect-video h-16 w-28 shrink-0 overflow-hidden rounded-md bg-muted">
                {it.thumbnail ? (
                  <img
                    src={it.thumbnail}
                    alt=""
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <Film className="h-5 w-5" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 py-0.5">
                <div className="mb-1 flex items-center gap-2">
                  <PlatformBadge platform={it.platform} />
                  <span
                    className="ml-auto font-mono text-[10px] text-muted-foreground"
                    title="Relatedness"
                  >
                    {it.score.toFixed(2)}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm font-medium leading-snug">
                  {it.title || it.source_url}
                </p>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
