import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUpRight, ExternalLink, FileDown, Hash, Quote, Sparkles } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api, type BulletinQuote } from "@/lib/api";
import { Badge, Button, Card } from "@/components/ui";
import { BackLink, ErrorState, LoadingState, PageHeader } from "@/components/shell";
import { formatDate } from "@/lib/utils";

function timestampLabel(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "";
  const total = Math.max(0, Math.round(timestamp));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function sourceAt(sourceUrl: string, timestamp: number | null): string {
  if (timestamp === null) return sourceUrl;
  try {
    const url = new URL(sourceUrl);
    if (url.hostname.includes("youtube.com") || url.hostname.includes("youtu.be")) url.searchParams.set("t", String(Math.round(timestamp)));
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function QuoteBlock({ quote, sourceUrl }: { quote: BulletinQuote; sourceUrl: string }) {
  const timestamp = timestampLabel(quote.timestamp);
  return (
    <blockquote className="rounded-xl border border-border bg-muted/20 p-4 sm:p-5">
      <Quote className="mb-3 h-4 w-4 text-primary/70" />
      <p className="font-serif text-lg leading-8 text-foreground/90">“{quote.text}”</p>
      <footer className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {quote.speaker && <span>{quote.speaker}</span>}
        {timestamp && <><span aria-hidden="true">·</span><a href={sourceAt(sourceUrl, quote.timestamp)} target="_blank" rel="noreferrer" className="text-primary hover:underline">{timestamp}</a></>}
      </footer>
    </blockquote>
  );
}

export function BulletinDetail() {
  const { id } = useParams();
  const itemId = Number(id);
  const bulletin = useQuery({ queryKey: ["bulletin", itemId], queryFn: () => api.getBulletin(itemId), enabled: itemId > 0 });

  if (bulletin.isLoading) return <LoadingState label="Loading detailed summary…" />;
  if (bulletin.isError || !bulletin.data) return <ErrorState message="This bulletin could not be loaded." onRetry={() => bulletin.refetch()} />;

  const item = bulletin.data;
  const points = item.bulletin.length > 0 ? item.bulletin : item.key_points;
  return (
    <div className="bulletin-detail mx-auto max-w-6xl">
      <div className="screen-only"><BackLink to="/bulletin" label="Bulletin" /></div>
      <PageHeader
        title={item.title}
        subtitle={`${item.author || "Source summary"} · ${item.published_at ? formatDate(item.published_at) : "Recent"}`}
        badges={<Badge className="bg-accent text-accent-foreground">Detailed summary</Badge>}
        actions={<Button className="screen-only" variant="outline" onClick={() => window.print()}><FileDown className="h-4 w-4" /> Export PDF</Button>}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <main className="space-y-6">
          <Card className="summary-paper bulletin-hero overflow-hidden p-6 sm:p-8">
            <div className="mb-5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              Bulletin · {item.published_at ? formatDate(item.published_at) : "Recent"}
            </div>
            {item.subhead && <p className="mb-5 max-w-3xl font-serif text-xl italic leading-8 text-muted-foreground">{item.subhead}</p>}
            {item.tldr && <div className="border-l-2 border-primary/60 pl-5"><p className="font-serif text-xl leading-9 text-foreground/90">{item.tldr}</p></div>}
            {points.length > 0 && (
              <ul className="mt-7 space-y-4 border-l border-primary/40 pl-5">
                {points.slice(0, 5).map((point) => <li key={point} className="relative font-serif text-base leading-7 text-foreground/90 before:absolute before:-left-[1.35rem] before:top-[0.75rem] before:h-1.5 before:w-1.5 before:rounded-full before:bg-primary/70">{point}</li>)}
              </ul>
            )}
          </Card>

          <Card className="p-6 sm:p-8">
            <div className="mb-6 flex items-start gap-3 border-b border-border pb-5">
              <div className="rounded-full bg-accent p-2 text-primary"><Sparkles className="h-4 w-4" /></div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">The full brief</p>
                <h2 className="mt-2 font-serif text-3xl font-semibold tracking-tight">Detailed summary</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">The bulletin is the short feed layer. The sections below preserve the original-language analysis and explain how the conclusion was built.</p>
              </div>
            </div>

            {(item.background || item.atmosphere) && (
              <div className="grid gap-4 md:grid-cols-2">
                {item.background && <section className="rounded-xl border border-border bg-muted/20 p-4"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Background</p><p className="text-sm leading-7 text-foreground/85">{item.background}</p></section>}
                {item.atmosphere && <section className="rounded-xl border border-border bg-muted/20 p-4"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Atmosphere & style</p><p className="text-sm leading-7 text-foreground/85">{item.atmosphere}</p></section>}
              </div>
            )}

            {item.key_points.length > 0 && (
              <section className="mt-8">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Key takeaways</p>
                <div className="mt-4 space-y-3">
                  {item.key_points.map((point, index) => <div key={point} className="flex gap-3 rounded-lg border border-border/70 p-4"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-primary">{index + 1}</span><p className="text-sm leading-7 text-foreground/85">{point}</p></div>)}
                </div>
              </section>
            )}

            {item.walkthrough && (
              <section className="mt-8 border-t border-border pt-8">
                <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Walkthrough</p>
                <div className="prose-sr max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.walkthrough}</ReactMarkdown></div>
              </section>
            )}

            {!item.walkthrough && item.markdown && (
              <section className="mt-8 border-t border-border pt-8">
                <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Full analysis</p>
                <div className="prose-sr max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.markdown}</ReactMarkdown></div>
              </section>
            )}

            {item.quotes.length > 0 && (
              <section className="mt-8 border-t border-border pt-8">
                <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Selected quotes</p>
                <div className="grid gap-3">{item.quotes.map((quote, index) => <QuoteBlock key={`${quote.text}-${index}`} quote={quote} sourceUrl={item.source_url} />)}</div>
              </section>
            )}
          </Card>
        </main>

        <aside className="space-y-4">
          <Card className="p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Source</p>
            <p className="mt-2 text-sm font-medium leading-6">{item.source_title}</p>
            {item.source_url && <a href={item.source_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline">Open original source <ExternalLink className="h-3 w-3" /></a>}
          </Card>
          {item.entities.length > 0 && <Card className="p-4"><p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"><Hash className="h-3.5 w-3.5" /> Entities</p><div className="mt-3 flex flex-wrap gap-1.5">{item.entities.map((entity) => <span key={entity} className="rounded-full border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">{entity}</span>)}</div></Card>}
          <Link to={`/items/${item.id}`} className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm text-primary transition-colors hover:bg-accent"><span>Open full source item</span><ArrowUpRight className="h-4 w-4" /></Link>
        </aside>
      </div>
    </div>
  );
}
