import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, ArrowUpRight, BookOpen, Clock3, ExternalLink, FileDown, List, RefreshCw } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type BulletinItem, type ReadingSummary } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { dateLabel, readingMinutes, sourceAt, timestampLabel } from "@/lib/bulletin";
import { cn } from "@/lib/utils";
import { Button, Select } from "@/components/ui";
import { ErrorState, LoadingState } from "@/components/shell";

const FullMarkdown = lazy(() => import("@/components/Highlightable").then((module) => ({ default: module.HighlightableMarkdown })));
const noOp = () => undefined;
type View = "summary" | "notes" | "sources";
function Markdown({ children }: { children: string }) { return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>; }

function SummaryBody({ summary, source, zh, print = false }: { summary: ReadingSummary; source: string; zh: boolean; print?: boolean }) {
  return <>
    <p className="reader-lead">{summary.lead}</p>
    {summary.sections.map((section, index) => <section className="reader-section" id={print ? undefined : `section-${index}`} key={index}>
      <div className="reader-section-heading"><span className="reader-section-number">{String(index + 1).padStart(2, "0")}</span><h2>{section.heading}</h2></div>
      <div className="reader-prose"><Markdown>{section.body}</Markdown></div>
      {section.timestamp !== null && <a href={sourceAt(source, section.timestamp)} target="_blank" rel="noreferrer" className="reader-citation"><BookOpen size={12} />{zh ? "来源片段" : "Source passage"} · {timestampLabel(section.timestamp)}<ArrowUpRight size={11} /></a>}
    </section>)}
    {summary.conclusion && <section className="reader-conclusion"><p className="desk-eyebrow">{zh ? "结论与保留意见" : "IN PERSPECTIVE"}</p><div className="reader-prose mt-3"><Markdown>{summary.conclusion}</Markdown></div></section>}
  </>;
}

export function BulletinDetail() {
  const { id } = useParams();
  const itemId = Number(id);
  const me = useMe();
  const zh = me.data?.user?.preferred_language === "zh";
  const [params, setParams] = useSearchParams();
  const selected = params.get("view");
  const view: View = selected === "notes" || selected === "sources" ? selected : "summary";
  const [printFull, setPrintFull] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState(false);
  const qc = useQueryClient();
  const queryKey = ["bulletin", itemId, me.data?.user?.id, zh];
  const bulletin = useQuery({
    queryKey, queryFn: () => api.getBulletin(itemId), enabled: Number.isInteger(itemId) && itemId > 0,
    refetchInterval: (query) => query.state.data?.reading_summary.status === "processing" || (zh && query.state.data?.localization_status === "processing") ? 3000 : false,
  });
  const preparation = useMutation({
    mutationFn: (id: number) => api.prepareReadingSummary(id),
    onSuccess: (result, id) => qc.setQueryData<BulletinItem>(["bulletin", id, me.data?.user?.id, zh], (old) => old ? { ...old, reading_summary: result } : old),
  });
  const localization = useMutation({
    mutationFn: (id: number) => api.prepareBulletin(id),
    onSuccess: (_result, id) => qc.invalidateQueries({ queryKey: ["bulletin", id] }),
  });
  const localizedAttempts = useRef(new Set<number>());
  useEffect(() => {
    if (zh && bulletin.data && !bulletin.data.bulletin_intro_ready && bulletin.data.localization_status !== "processing" && !localizedAttempts.current.has(itemId)) {
      localizedAttempts.current.add(itemId);
      localization.mutate(itemId);
    }
  }, [itemId, zh, bulletin.data?.bulletin_intro_ready, bulletin.data?.localization_status]);
  const attempted = useRef(new Set<number>());
  useEffect(() => {
    if (view === "summary" && bulletin.data?.reading_summary.status === "missing" && !attempted.current.has(itemId)) {
      attempted.current.add(itemId);
      preparation.mutate(itemId);
    }
  }, [itemId, bulletin.data?.reading_summary.status, view]); // A missing edition is prepared once; errors require an explicit retry.
  useEffect(() => { setPrintFull(false); }, [itemId]);

  if (bulletin.isLoading) return <LoadingState label={zh ? "正在打开阅读稿…" : "Opening your reading edition…"} />;
  if (bulletin.isError || !bulletin.data) return <ErrorState message={zh ? "这篇简报暂时无法打开。" : "This bulletin could not be loaded."} onRetry={() => bulletin.refetch()} />;
  const item = bulletin.data;
  const summary = item.reading_summary.content;
  const preparing = (preparation.isPending && preparation.variables === itemId) || item.reading_summary.status === "processing";
  const summaryText = summary ? [summary.lead, ...summary.sections.map((section) => section.body), summary.conclusion].join(" ") : item.tldr;
  const setView = (next: View) => setParams((previous) => { const p = new URLSearchParams(previous); if (next === "summary") p.delete("view"); else p.set("view", next); return p; }, { replace: true });
  const exportPdf = async () => {
    setPrinting(true);
    setPrintError(false);
    try {
      if (printFull) {
        await import("@/components/Highlightable");
        // The full edition may contain lazy-rendered diagrams. Let them settle
        // before the browser snapshots the print tree.
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, 100));
          if (document.querySelector(".print-full-notes .prose-sr") && !document.querySelector(".print-full-notes [role='status']")) break;
        }
      }
      if (printFull && (!document.querySelector(".print-full-notes .prose-sr") || document.querySelector(".print-full-notes [role='status']"))) throw new Error("Print content is still loading");
      await document.fonts.ready;
      window.print();
    } catch { setPrintError(true); } finally { setPrinting(false); }
  };
  const tabs: { value: View; label: string }[] = [{ value: "summary", label: zh ? "精炼概括" : "Summary" }, { value: "notes", label: zh ? "完整逐段内容" : "Deep dive" }, { value: "sources", label: zh ? "引文与来源" : "Sources & quotes" }];

  return <div className="reading-edition mx-auto max-w-6xl">
    <div className="reader-screen screen-only">
      <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <Link to="/bulletin" className="desk-utility"><ArrowLeft size={15} />{zh ? "返回 Bulletin" : "Back to Bulletin"}</Link>
        <div className="flex items-center gap-2"><Select value={printFull ? "full" : "summary"} onChange={(event) => setPrintFull(event.target.value === "full")} aria-label={zh ? "PDF 内容" : "PDF contents"} className="w-auto bg-transparent text-xs"><option value="summary">{zh ? "简报 + 精炼概括" : "Bulletin + summary"}</option><option value="full">{zh ? "包含完整逐段内容" : "Include deep dive"}</option></Select><Button variant="outline" aria-label={zh ? "导出 PDF" : "Export PDF"} disabled={printing || (zh && !item.bulletin_intro_ready) || (!summary && !printFull)} onClick={exportPdf}>{printing ? <RefreshCw size={14} className="animate-spin" /> : <FileDown size={14} />}<span className="hidden sm:inline">{zh ? "导出 PDF" : "Export PDF"}</span></Button></div>
      </div>
      {printError && <p role="alert" className="mb-4 text-sm text-muted-foreground">{zh ? "完整内容尚未加载完毕，请稍后重试导出。" : "The full edition is still loading. Please try exporting again in a moment."}</p>}
      <div className="reader-heading">
        <p className="desk-eyebrow">{item.author || item.platform}<span className="text-border">/</span>{dateLabel(item.published_at || item.created_at, zh)}</p>
        <h1>{item.title}</h1>
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><Clock3 size={13} />{readingMinutes(summaryText)} {zh ? "分钟精读" : "min read"}</span><span>{zh ? "精炼概括保留原文语言" : "Summary in the source language"}</span><a href={item.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-primary">{zh ? "原始来源" : "Original source"}<ExternalLink size={12} /></a></div>
      </div>
      <div className="reader-columns">
        <div className="min-w-0">
          <section className="reader-bulletin" aria-label="Bulletin">
            <div className="mb-4 flex items-center justify-between"><p className="desk-eyebrow text-primary">BULLETIN</p><span className="font-mono text-[10px] text-muted-foreground">{item.bulletin_language === "zh" ? "中文" : (zh ? "原文" : "AT A GLANCE")}</span></div>
            {zh && !item.bulletin_intro_ready && <div className="mb-4 text-sm text-muted-foreground" role="status">{localization.isPending || item.localization_status === "processing" ? "正在补齐中文标题与概览…" : <button onClick={() => localization.mutate(itemId)} className="underline">中文概览暂未就绪，点击重试</button>}</div>}
            {item.bulletin_overview && <p className="mb-5 text-sm leading-7">{item.bulletin_overview}</p>}
            <ul>{item.bulletin_points.map((point, index) => <li key={index}>{point.text}{point.timestamp !== null && <a href={sourceAt(item.source_url, point.timestamp)} target="_blank" rel="noreferrer" className="ml-2 whitespace-nowrap font-mono text-[10px] text-primary hover:underline">{timestampLabel(point.timestamp)}</a>}</li>)}</ul>
            {!zh && !item.bulletin_points.length && !item.bulletin_overview && <p className="text-sm leading-7">{item.summary || item.tldr}</p>}
          </section>
          <div className="reader-tabs" role="tablist" aria-label={zh ? "阅读层次" : "Reading views"}>{tabs.map((tab) => <button key={tab.value} id={`tab-${tab.value}`} role="tab" aria-selected={view === tab.value} aria-controls={`panel-${tab.value}`} tabIndex={view === tab.value ? 0 : -1} onKeyDown={(event) => {
            const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const index = tabs.findIndex((entry) => entry.value === tab.value);
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            setView(tabs[next].value);
            document.getElementById(`tab-${tabs[next].value}`)?.focus();
          }} className={cn("reader-tab", view === tab.value && "is-active")} onClick={() => setView(tab.value)}>{tab.label}</button>)}</div>
          <article className="reader-article" role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`}>
            {view === "summary" && (summary ? <SummaryBody summary={summary} source={item.source_url} zh={zh} /> : <>
              <div className="reader-preparing" role="status">{preparing ? <RefreshCw size={18} className="shrink-0 animate-spin" /> : <BookOpen size={18} className="shrink-0" />}<div><p className="font-medium">{preparing ? (zh ? "正在整理这篇精炼概括" : "Preparing your reading edition") : (zh ? "精炼概括暂时未就绪" : "The reading edition isn’t ready yet")}</p><p className="mt-1 text-sm leading-6 text-muted-foreground">{zh ? "先阅读下面的原有概览，或切换到完整逐段内容。" : "You can read the existing overview below, or switch to the full notes."}</p>{!preparing && <Button size="sm" variant="outline" className="mt-3" onClick={() => preparation.mutate(itemId)}>{zh ? "重新生成概括" : "Retry summary"}</Button>}</div></div>
              {item.tldr && <p className="reader-lead">{item.tldr}</p>}
              {item.key_point_details.length > 0 && <section className="reader-section"><h2>{zh ? "原有内容要点" : "Source takeaways"}</h2><ul className="reader-source-points">{item.key_point_details.slice(0, 6).map((point, index) => <li key={index}>{point.text}</li>)}</ul></section>}
            </>)}
            {view === "notes" && <><p className="mb-6 text-xs text-muted-foreground">{zh ? "保留完整论述、例子与时间线。" : "The full argument, examples and chronological notes."}</p><Suspense fallback={<LoadingState label={zh ? "加载完整内容…" : "Loading full notes…"} />}><FullMarkdown markdown={item.walkthrough || item.markdown} highlights={[]} source="summary" readOnly onCreate={noOp} onUpdateNote={noOp} onDelete={noOp} className="prose-sr reader-prose" /></Suspense></>}
            {view === "sources" && <><section className="reader-section pt-0"><p className="desk-eyebrow">{zh ? "原始来源" : "ORIGINAL SOURCE"}</p><h2 className="mt-3">{item.source_title}</h2><p className="reader-prose mt-4">{item.background}</p><a href={item.source_url} target="_blank" rel="noreferrer" className="reader-citation mt-4">{zh ? "打开原始来源" : "Open original source"}<ArrowUpRight size={12} /></a></section>{item.quotes.map((quote, index) => <blockquote className="reader-quote" key={index}><p>“{quote.text}”</p><footer>{quote.speaker}{quote.timestamp !== null && <a href={sourceAt(item.source_url, quote.timestamp)} target="_blank" rel="noreferrer"> · {timestampLabel(quote.timestamp)} ↗</a>}</footer></blockquote>)}{!item.quotes.length && <p className="text-sm text-muted-foreground">{zh ? "这篇内容未提取单独引文，可在完整内容中查阅。" : "No separate quotes were extracted. You can inspect the full notes."}</p>}<Link to={`/items/${item.id}`} className="reader-citation mt-8">{zh ? "查看逐字稿、笔记与标注" : "Open transcript, notes & highlights"}<ArrowUpRight size={13} /></Link></>}
          </article>
        </div>
        <aside className="reader-toc">
          <div className="sticky top-8 space-y-7">
            <div><p className="desk-eyebrow"><List size={13} />{zh ? "本篇导读" : "IN THIS BRIEF"}</p>{summary ? <ol className="mt-4 space-y-3">{summary.sections.map((section, index) => <li key={index}><a href={`#section-${index}`} className="flex gap-2 text-xs leading-5 text-muted-foreground hover:text-primary" onClick={(event) => {
              event.preventDefault();
              setView("summary");
              requestAnimationFrame(() => document.getElementById(`section-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
            }}><span className="font-mono text-primary/70">{String(index + 1).padStart(2, "0")}</span>{section.heading}</a></li>)}</ol> : <p className="mt-3 text-xs leading-6 text-muted-foreground">{zh ? "概括就绪后显示阅读目录。" : "A reading guide appears when the summary is ready."}</p>}</div>
            {item.entities.length > 0 && <div className="border-t border-border pt-5"><p className="desk-eyebrow">{zh ? "文中提及" : "MENTIONED"}</p><div className="mt-3 flex flex-wrap gap-2">{item.entities.slice(0, 12).map((entity) => <span key={entity} className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground">{entity}</span>)}</div></div>}
            <Link to={`/items/${item.id}`} className="desk-utility text-xs">{zh ? "逐字稿与笔记" : "Transcript & notes"}<ArrowUpRight size={12} /></Link>
          </div>
        </aside>
      </div>
    </div>
    <article className="reading-print">
      <p className="print-kicker">STREAM-REDUCE / THE BULLETIN</p><h1>{item.title}</h1><p className="print-meta">{item.author} · {dateLabel(item.published_at || item.created_at, zh)}</p>
      {item.bulletin_overview && <p className="print-lead">{item.bulletin_overview}</p>}
      <ul className="print-bulletin">{item.bulletin.map((point, index) => <li key={index}>{point}</li>)}</ul>
      {summary && <div className="print-detailed"><SummaryBody summary={summary} source={item.source_url} zh={zh} print /></div>}
      {printFull && <div className="print-detailed print-full-notes"><h2>{zh ? "完整逐段内容" : "Full notes"}</h2><Suspense fallback={<p>{zh ? "正在加载完整内容…" : "Loading full notes…"}</p>}><FullMarkdown markdown={item.walkthrough || item.markdown} highlights={[]} source="summary" readOnly onCreate={noOp} onUpdateNote={noOp} onDelete={noOp} className="prose-sr reader-prose" /></Suspense></div>}
      <p className="print-source">{zh ? "来源" : "Source"}: {item.source_title}<br /><a href={item.source_url}>{item.source_url}</a></p>
    </article>
  </div>;
}
