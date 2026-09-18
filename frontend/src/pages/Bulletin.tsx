import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, ExternalLink, Newspaper, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { api, type BulletinItem } from "@/lib/api";
import { Badge, Button, Card } from "@/components/ui";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/shell";
import { formatDate } from "@/lib/utils";

const PAGE_SIZE = 60;

export function Bulletin() {
  const feed = useInfiniteQuery({
    queryKey: ["bulletin", "feed"],
    queryFn: ({ pageParam }) => api.listBulletins(PAGE_SIZE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined,
  });
  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];

  if (feed.isLoading) return <LoadingState label="Loading bulletin…" />;
  if (feed.isError) return <ErrorState message="The bulletin could not be loaded." onRetry={() => feed.refetch()} />;

  return (
    <div className="bulletin-page mx-auto max-w-5xl">
      <PageHeader
        title="Bulletin"
        subtitle="A living stream of the highest-signal points from the sources in your library. Open any entry for the full detailed summary."
        actions={
          <Link to="/research?view=setup">
            <Button variant="outline"><Newspaper className="h-4 w-4" /> Configure agents</Button>
          </Link>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<Newspaper className="h-5 w-5" />}
          title="Your bulletin is empty"
          description="Add a source to your library or follow a channel. Once a summary is ready, its bulletin will appear here."
          action={<Link to="/library"><Button>Open knowledge base</Button></Link>}
        />
      ) : (
        <>
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Your signal desk</p>
              <p className="mt-1 text-sm text-muted-foreground">{items.length} bulletin{items.length === 1 ? "" : "s"} loaded</p>
            </div>
            {feed.isFetching && <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Refreshing</span>}
          </div>
          <div className="relative space-y-6 before:absolute before:bottom-5 before:left-[0.45rem] before:top-5 before:w-px before:bg-border">
            {items.map((item) => <BulletinCard key={item.id} item={item} />)}
          </div>
          {feed.hasNextPage && (
            <div className="mt-8 flex justify-center">
              <Button variant="outline" onClick={() => feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
                {feed.isFetchingNextPage ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                {feed.isFetchingNextPage ? "Loading…" : "Load older bulletins"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BulletinCard({ item }: { item: BulletinItem }) {
  const points = item.bulletin.length > 0 ? item.bulletin : item.key_points;
  return (
    <div className="relative pl-6">
      <span className="absolute left-0 top-6 z-10 h-[0.6rem] w-[0.6rem] rounded-full border-2 border-background bg-primary shadow-sm" aria-hidden="true" />
      <Card interactive className="overflow-hidden">
        <Link to={`/bulletin/${item.id}`} className="block p-5 sm:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge className="bg-accent text-accent-foreground">Bulletin</Badge>
            <span>{item.published_at ? formatDate(item.published_at) : "Recent"}</span>
            {item.author && <span>{item.author}</span>}
            <span className="ml-auto inline-flex items-center gap-1 text-primary">Open detail <ChevronRight className="h-3.5 w-3.5" /></span>
          </div>
          <h2 className="max-w-3xl font-serif text-2xl font-semibold leading-tight tracking-tight">{item.title}</h2>
          {item.subhead && <p className="mt-2 max-w-3xl font-serif text-base italic leading-6 text-muted-foreground">{item.subhead}</p>}
          {item.summary && <p className="mt-4 max-w-3xl border-l-2 border-primary/50 pl-3 font-serif text-base leading-7 text-foreground/85">{item.summary}</p>}
          {points.length > 0 && (
            <ul className="mt-5 grid gap-3 text-sm leading-6 text-foreground/85 md:grid-cols-2">
              {points.slice(0, 4).map((point) => <li key={point} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden="true" /><span>{point}</span></li>)}
            </ul>
          )}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-3 text-xs sm:px-6">
          <Link to={`/bulletin/${item.id}`} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"><ArrowUpRight className="h-3.5 w-3.5" /> Read detailed summary</Link>
          {item.source_url && <a href={item.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Original source</a>}
        </div>
      </Card>
    </div>
  );
}
