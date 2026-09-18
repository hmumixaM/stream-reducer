import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Play,
  Plus,
  Radar,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ResearchAgent, type ResearchAsk, type ResearchBrief } from "@/lib/api";
import { Badge, Button, Card, Input, Select, Spinner, Switch } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  FilterChip,
  LoadingState,
  PageHeader,
  SectionHeader,
} from "@/components/shell";
import { formatDate } from "@/lib/utils";

type View = "feed" | "setup";

export function Research() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get("view");
  const [view, setViewState] = useState<View>(requestedView === "setup" ? "setup" : "feed");
  useEffect(() => {
    setViewState(requestedView === "setup" ? "setup" : "feed");
  }, [requestedView]);
  const setView = (next: View) => {
    setViewState(next);
    const params = new URLSearchParams(searchParams);
    if (next === "setup") params.set("view", "setup");
    else params.delete("view");
    setSearchParams(params, { replace: true });
  };
  const queryClient = useQueryClient();
  const briefs = useQuery({ queryKey: ["research", "feed"], queryFn: () => api.listResearchBriefs(60) });
  const coverage = useQuery({ queryKey: ["research", "coverage"], queryFn: api.listResearchCoverage });
  const agents = useQuery({ queryKey: ["research", "agents"], queryFn: api.listResearchAgents });
  const asks = useQuery({ queryKey: ["research", "asks"], queryFn: api.listResearchAsks });
  const run = useMutation({
    mutationFn: api.runResearch,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["research"] }),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["research"] });
  };

  return (
    <div>
      <PageHeader
        title="Research"
        subtitle="A focused layer over your channels: track names and themes, then review sourced briefs as they appear."
        actions={
          <Button onClick={() => run.mutate()} disabled={run.isPending} title="Build briefs from recent summaries">
            {run.isPending ? <Spinner /> : <Play className="h-4 w-4" />}
            Run research
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Research views">
        <FilterChip label="Brief feed" active={view === "feed"} onClick={() => setView("feed")} />
        <FilterChip label="Coverage & agents" active={view === "setup"} onClick={() => setView("setup")} />
      </div>

      {run.isError && <ErrorState compact message={`Research run failed: ${run.error.message}`} onRetry={() => run.mutate()} />}
      {run.isSuccess && (
        <p className="mb-4 text-sm text-muted-foreground" role="status">
          {run.data.created ? `Added ${run.data.created} new brief${run.data.created === 1 ? "" : "s"}.` : "No new matches yet."}
        </p>
      )}

      {view === "feed" ? (
        <div className="space-y-6">
          <AskResearch asks={asks.data ?? []} isLoading={asks.isLoading} onChanged={() => asks.refetch()} />
          <BriefFeed briefs={briefs.data ?? []} isLoading={briefs.isLoading} isError={briefs.isError} onRetry={() => briefs.refetch()} onSetup={() => setView("setup")} />
        </div>
      ) : (
        <ResearchSetup
          coverage={coverage.data ?? []}
          agents={agents.data ?? []}
          isLoading={coverage.isLoading || agents.isLoading}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function AskResearch({ asks, isLoading, onChanged }: { asks: ResearchAsk[]; isLoading: boolean; onChanged: () => void }) {
  const [question, setQuestion] = useState("");
  const ask = useMutation({ mutationFn: () => api.askResearch(question), onSuccess: () => { setQuestion(""); onChanged(); } });
  return (
    <Card className="p-4 sm:p-5">
      <SectionHeader title="Ask your library" subtitle="Get a cited answer from the summaries you saved or followed. Answers stay grounded in the sources shown below." />
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (question.trim()) ask.mutate(); }}>
        <Input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="e.g. What are people saying about datacenter power?" aria-label="Research question" />
        <Button type="submit" disabled={ask.isPending || !question.trim()}>{ask.isPending ? <Spinner /> : <Sparkles className="h-4 w-4" />} Ask</Button>
      </form>
      {ask.isError && <p className="mt-2 text-sm text-danger" role="alert">{ask.error.message}</p>}
      {ask.data && <AskAnswer ask={ask.data} />}
      {!ask.data && !isLoading && asks[0] && <AskAnswer ask={asks[0]} muted />}
    </Card>
  );
}

function AskAnswer({ ask, muted = false }: { ask: ResearchAsk; muted?: boolean }) {
  return (
    <div className={muted ? "mt-4 border-t border-border pt-4 opacity-90" : "mt-4 border-t border-border pt-4"}>
      <p className="text-xs font-medium text-muted-foreground">{muted ? "Last ask" : "Answer"}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{ask.answer}</p>
      {ask.sources.length > 0 && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {ask.sources.slice(0, 4).map((source) => <a key={source.item_id} href={source.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="h-3 w-3" />{source.title}</a>)}
      </div>}
    </div>
  );
}

function BriefFeed({
  briefs,
  isLoading,
  isError,
  onRetry,
  onSetup,
}: {
  briefs: ResearchBrief[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onSetup: () => void;
}) {
  if (isLoading) return <LoadingState label="Loading your research feed…" />;
  if (isError) return <ErrorState message="Research briefs could not be loaded." onRetry={onRetry} />;
  if (!briefs.length) {
    return (
      <EmptyState
        icon={<Radar className="h-5 w-5" />}
        title="Your research feed is empty"
        description="Add a few names or themes, follow some channels, and run research to file the first sourced brief."
        action={<Button variant="outline" onClick={onSetup}><Plus className="h-4 w-4" /> Set up coverage</Button>}
      />
    );
  }
  return (
    <div className="space-y-3">
      {briefs.map((brief) => <BriefCard key={brief.id} brief={brief} />)}
    </div>
  );
}

function BriefCard({ brief }: { brief: ResearchBrief }) {
  const label = brief.coverage_label || brief.agent_name || "Research brief";
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge className="bg-accent text-accent-foreground">{brief.brief_type}</Badge>
        <span>{label}</span>
        {brief.item_published_at && <span>{formatDate(brief.item_published_at)}</span>}
        <span className="ml-auto">Filed {formatDate(brief.created_at)}</span>
      </div>
      <h2 className="text-base font-semibold leading-snug">{brief.title}</h2>
      <p className="mt-2 text-sm leading-6 text-foreground/90">{brief.summary}</p>
      {brief.key_points.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {brief.key_points.slice(0, 4).map((point) => <li key={point} className="flex gap-2"><span aria-hidden="true">•</span><span>{point}</span></li>)}
        </ul>
      )}
      {brief.source_url && (
        <a href={brief.source_url} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-xs text-primary hover:underline">
          Open source <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </Card>
  );
}

function ResearchSetup({
  coverage,
  agents,
  isLoading,
  onChanged,
}: {
  coverage: Awaited<ReturnType<typeof api.listResearchCoverage>>;
  agents: ResearchAgent[];
  isLoading: boolean;
  onChanged: () => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"name" | "ticker">("ticker");
  const [agentName, setAgentName] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentKind, setAgentKind] = useState<"theme" | "custom">("theme");
  const addCoverage = useMutation({ mutationFn: () => api.addResearchCoverage(label, kind), onSuccess: () => { setLabel(""); onChanged(); } });
  const removeCoverage = useMutation({ mutationFn: api.deleteResearchCoverage, onSuccess: onChanged });
  const addAgent = useMutation({ mutationFn: () => api.addResearchAgent({ name: agentName, prompt: agentPrompt || agentName, kind: agentKind }), onSuccess: () => { setAgentName(""); setAgentPrompt(""); onChanged(); } });
  const updateAgent = useMutation({ mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.updateResearchAgent(id, { enabled }), onSuccess: onChanged });
  const removeAgent = useMutation({ mutationFn: api.deleteResearchAgent, onSuccess: onChanged });

  if (isLoading) return <LoadingState label="Loading research setup…" />;
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card className="p-5">
        <SectionHeader title="Coverage universe" subtitle="Names and tickers your appearance agent should watch across every followed source." />
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (label.trim()) addCoverage.mutate(); }}>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. NVIDIA or NVDA" aria-label="Name or ticker" />
          <Select value={kind} onChange={(event) => setKind(event.target.value as "name" | "ticker")} className="sm:w-28" aria-label="Coverage type">
            <option value="ticker">Ticker</option><option value="name">Name</option>
          </Select>
          <Button type="submit" disabled={addCoverage.isPending || !label.trim()}><Plus className="h-4 w-4" /> Add</Button>
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          {coverage.map((entry) => (
            <span key={entry.id} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-sm">
              <Link to={`/dossiers/${encodeURIComponent(entry.label)}`} className="hover:text-primary hover:underline">{entry.label}</Link>
              <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-danger" onClick={() => removeCoverage.mutate(entry.id)} aria-label={`Remove ${entry.label}`} title={`Remove ${entry.label}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          {!coverage.length && <p className="text-sm text-muted-foreground">No names yet. Add the companies, people, or products you cover.</p>}
        </div>
      </Card>

      <Card className="p-5">
        <SectionHeader title="Thematic agents" subtitle="A plain-language assignment that turns matching summaries into a personal feed." />
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (agentName.trim()) addAgent.mutate(); }}>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="e.g. Datacenter power" aria-label="Agent name" />
            <Select value={agentKind} onChange={(event) => setAgentKind(event.target.value as "theme" | "custom")} className="sm:w-28" aria-label="Agent type">
              <option value="theme">Theme</option><option value="custom">Custom</option>
            </Select>
          </div>
          <Input value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} placeholder="What should this agent look for?" aria-label="Agent prompt" />
          <Button type="submit" disabled={addAgent.isPending || !agentName.trim()}><Sparkles className="h-4 w-4" /> Create agent</Button>
        </form>
        <div className="mt-5 divide-y divide-border border-t border-border">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} onToggle={(enabled) => updateAgent.mutate({ id: agent.id, enabled })} onDelete={() => removeAgent.mutate(agent.id)} />
          ))}
          {!agents.length && <p className="pt-4 text-sm text-muted-foreground">No thematic agents yet. Create one to track a question across your sources.</p>}
        </div>
      </Card>
    </div>
  );
}

function AgentRow({ agent, onToggle, onDelete }: { agent: ResearchAgent; onToggle: (enabled: boolean) => void; onDelete: () => void }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{agent.name}</span><Badge className="bg-muted text-muted-foreground">{agent.kind}</Badge></div>
        <p className="mt-1 text-xs text-muted-foreground">{agent.prompt}</p>
      </div>
      <Switch checked={agent.enabled} onCheckedChange={onToggle} label={agent.enabled ? "On" : "Off"} className="shrink-0 text-xs" />
      <Button size="icon" variant="ghost" onClick={onDelete} title={`Delete ${agent.name}`} aria-label={`Delete ${agent.name}`}><Trash2 className="h-4 w-4 text-danger" /></Button>
    </div>
  );
}
