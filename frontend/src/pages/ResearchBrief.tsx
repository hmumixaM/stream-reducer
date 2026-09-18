import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, FileDown } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { Badge, Button, Card } from "@/components/ui";
import { BackLink, ErrorState, LoadingState, PageHeader } from "@/components/shell";
import { formatDate } from "@/lib/utils";

function localizedBulletin(structured: Record<string, unknown>): string[] {
  const raw = Array.isArray(structured.bulletin) ? structured.bulletin : [];
  return raw.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (entry && typeof entry === "object" && "text" in entry) return String(entry.text ?? "").trim();
    return "";
  }).filter(Boolean).slice(0, 5);
}

export function ResearchBrief() {
  const { id } = useParams();
  const briefId = Number(id);
  const brief = useQuery({ queryKey: ["research", "brief", briefId], queryFn: () => api.getResearchBrief(briefId), enabled: briefId > 0 });
  if (brief.isLoading) return <LoadingState label="Loading brief…" />;
  if (brief.isError || !brief.data) return <ErrorState message="This brief could not be loaded." onRetry={() => brief.refetch()} />;
  const { brief: data, summary } = brief.data;
  const bulletin = data.bulletin.length > 0 ? data.bulletin : localizedBulletin(summary?.structured ?? {});
  return (
    <div className="research-brief-detail mx-auto max-w-4xl">
      <BackLink to="/research" label="Research" />
      <PageHeader title={data.title} subtitle={`${data.coverage_label || data.agent_name || "Research brief"} · ${formatDate(data.created_at)}`} badges={<Badge className="bg-accent text-accent-foreground">{data.brief_type}</Badge>} actions={<Button variant="outline" onClick={() => window.print()}><FileDown className="h-4 w-4" /> Export PDF</Button>} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <main className="space-y-5">
          <Card className="summary-paper p-6">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Bulletin · {data.item_published_at ? formatDate(data.item_published_at) : "Recent"}</p>
            <p className="font-serif text-xl leading-8 text-foreground/90">{data.summary}</p>
            {bulletin.length > 0 && <ul className="mt-6 space-y-4 border-l border-primary/40 pl-5">{bulletin.map((point) => <li key={point} className="relative font-serif text-base leading-7 before:absolute before:-left-[1.35rem] before:top-[0.75rem] before:h-1.5 before:w-1.5 before:rounded-full before:bg-primary/70">{point}</li>)}</ul>}
            {data.source_url && <a href={data.source_url} target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-1 text-xs text-primary hover:underline">Read original source <ExternalLink className="h-3 w-3" /></a>}
          </Card>
          {summary && <Card className="p-6"><div className="mb-4 border-b border-border pb-3"><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Detailed summary</p><h2 className="mt-2 font-serif text-2xl font-semibold tracking-tight">The full brief</h2><p className="mt-1 text-sm text-muted-foreground">The original-language analysis remains intact below.</p></div><div className="prose-sr max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.markdown}</ReactMarkdown></div></Card>}
        </main>
        <aside className="space-y-4">
          <Card className="p-4"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Source</p><p className="mt-2 text-sm font-medium">{data.item_title || data.title}</p>{data.source_url && <a href={data.source_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline">Open source <ExternalLink className="h-3 w-3" /></a>}</Card>
          <Link to={`/items/${data.item_id}`} className="block text-sm text-primary hover:underline">Open the source item →</Link>
        </aside>
      </div>
    </div>
  );
}
