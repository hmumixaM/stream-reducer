import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FolderSearch } from "lucide-react";
import { useParams } from "react-router-dom";
import { api, type ResearchBrief } from "@/lib/api";
import { Badge, Card } from "@/components/ui";
import { BackLink, EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/shell";
import { formatDate } from "@/lib/utils";

export function Dossier() {
  const { slug = "" } = useParams();
  const dossier = useQuery({
    queryKey: ["research", "dossier", slug],
    queryFn: () => api.getResearchDossier(slug),
    enabled: Boolean(slug),
  });

  if (dossier.isLoading) return <LoadingState label="Loading dossier…" />;
  if (dossier.isError) return <ErrorState message="This dossier could not be loaded." onRetry={() => dossier.refetch()} />;
  if (!dossier.data) return null;

  return (
    <div>
      <BackLink to="/research" label="Research" />
      <PageHeader
        title={dossier.data.coverage.label}
        subtitle={`${dossier.data.mention_count} sourced mention${dossier.data.mention_count === 1 ? "" : "s"} in your research feed.`}
        badges={<Badge className="bg-accent text-accent-foreground">{dossier.data.coverage.kind}</Badge>}
      />
      {dossier.data.mentions.length ? (
        <div className="space-y-3">
          {dossier.data.mentions.map((brief) => <DossierMention key={brief.id} brief={brief} />)}
        </div>
      ) : (
        <EmptyState icon={<FolderSearch className="h-5 w-5" />} title="No mentions yet" description="Run research after a relevant episode has been summarized." />
      )}
    </div>
  );
}

function DossierMention({ brief }: { brief: ResearchBrief }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{brief.item_published_at ? formatDate(brief.item_published_at) : "Recent"}</span>
        <span>{brief.brief_type}</span>
      </div>
      <h2 className="font-serif text-xl font-semibold tracking-tight">{brief.title}</h2>
      <p className="mt-2 border-l-2 border-primary/50 pl-3 font-serif text-base italic leading-6 text-foreground/80">{brief.summary}</p>
      {(brief.bulletin.length > 0 ? brief.bulletin : brief.key_points).length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {(brief.bulletin.length > 0 ? brief.bulletin : brief.key_points).slice(0, 5).map((point) => <li key={point} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary/60" aria-hidden="true" /><span>{point}</span></li>)}
        </ul>
      )}
      {brief.source_url && <a href={brief.source_url} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-xs text-primary hover:underline">Open source <ExternalLink className="h-3 w-3" /></a>}
    </Card>
  );
}
