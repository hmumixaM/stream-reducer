import { ReaderHeader, ReaderTabs, ReaderOutline, ReaderOverview, useReaderNavigation } from "@/components/Reader";
import { useArticleMetadata } from "@/lib/seo";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUpRight, BookOpen, Bookmark, Check, FileDown } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api, type BulletinItem, type ReadingSummary } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { dateLabel, readingMinutes, sourceAt, timestampLabel } from "@/lib/bulletin";
import { Button, Select } from "@/components/ui";
import { ContentLanguageBar, languageLabel } from "@/components/ContentLanguage";
import { isPredominantlyChinese } from "@/lib/chinese";
import { ErrorState, LoadingState } from "@/components/shell";

const FullMarkdown = lazy(() => import("@/components/Highlightable").then((module) => ({ default: module.HighlightableMarkdown })));
const noOp = () => undefined;
const MediaSummaryNotes = lazy(() => import("@/pages/ItemDetail").then(module => ({ default: module.MediaSummaryNotes })));
const MediaSourceContent = lazy(() => import("@/pages/ItemDetail").then(module => ({ default: module.MediaSourceContent })));
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

function pointsOf(structured: Record<string, unknown>, field = "bulletin"): { text: string; timestamp: number | null }[] {
  const raw = structured[field];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [{ text: entry.trim(), timestamp: null }];
    if (!entry || typeof entry !== "object" || !("text" in entry) || typeof entry.text !== "string" || !entry.text.trim()) return [];
    const timestamp = "timestamp" in entry && typeof entry.timestamp === "number" && entry.timestamp >= 0 ? entry.timestamp : null;
    return [{ text: entry.text.trim(), timestamp }];
  });
}

function richestPoints(structured: Record<string, unknown>) {
  const bulletin = pointsOf(structured, "bulletin");
  const keyPoints = pointsOf(structured, "key_points");
  return keyPoints.length > bulletin.length ? keyPoints : bulletin;
}

export function BulletinDetail() {
  const { id } = useParams();
  const itemId = Number(id);
  const me = useMe();
  const authed = !!me.data?.user;
  const preferred = me.data?.user?.preferred_language || "auto";
  const zh = preferred === "zh";
  const navigation = useReaderNavigation(authed ? "/bulletin" : "/browse");
  const { params, setParams, view, setView, location } = navigation;
  const collection = params.get("collection");
  const returnParams = new URLSearchParams({ view: "bulletin" });
  for (const key of ["section", "track_id"]) if (params.get(key)) returnParams.set(key, params.get(key)!);
  const backTo = collection && !location.state?.readerFrom ? `/collections/${encodeURIComponent(collection)}?${returnParams}` : navigation.backTo;
  const fullNotes = params.get("view") === "notes" || params.get("detail") === "full";
  const setFullNotes = (full: boolean) => setParams(previous => { const p = new URLSearchParams(previous); p.set("view", "summary"); if (full) p.set("detail", "full"); else p.delete("detail"); return p; }, { state: location.state });
  const [printFull, setPrintFull] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState(false);
  const qc = useQueryClient();
  const queryKey = ["bulletin", itemId, me.data?.user?.id, preferred];
  const bulletin = useQuery({
    queryKey, queryFn: () => api.getBulletin(itemId), enabled: Number.isInteger(itemId) && itemId > 0,
    refetchInterval: (query) => query.state.data?.reading_summary.status === "processing" || query.state.data?.reading_summary_zh?.status === "processing" || query.state.data?.reading_summary_en?.status === "processing" || (preferred !== "auto" && query.state.data?.localization_status === "processing") ? 3000 : false,
  });
  useArticleMetadata(itemId, bulletin.data?.title, bulletin.data?.subhead || bulletin.data?.tldr);
  const preparation = useMutation({
    mutationFn: ({ id, lang }: { id: number; lang?: "zh" | "en" }) => api.prepareReadingSummary(id, lang),
    onSuccess: (result, { id, lang }) => qc.setQueryData<BulletinItem>(["bulletin", id, me.data?.user?.id, preferred], (old) => old ? { ...old, ...(lang === "zh" ? { reading_summary_zh: result } : lang === "en" ? { reading_summary_en: result } : { reading_summary: result }) } : old),
  });
  const localization = useMutation({
    mutationFn: (id: number) => api.prepareBulletin(id),
    onSuccess: (_result, id) => qc.invalidateQueries({ queryKey: ["bulletin", id] }),
  });
  const localizedAttempts = useRef(new Set<string>());
  useEffect(() => {
    if (!authed) return;
    if (preferred !== "auto" && bulletin.data && !bulletin.data.bulletin_intro_ready && bulletin.data.localization_status !== "processing" && !localizedAttempts.current.has(`${itemId}:${preferred}`)) {
      localizedAttempts.current.add(`${itemId}:${preferred}`);
      localization.mutate(itemId);
    }
  }, [authed, itemId, preferred, bulletin.data?.bulletin_intro_ready, bulletin.data?.localization_status]);
  const attempted = useRef(new Set<string>());
  const askedEditions = useRef(new Set<string>());
  const nativeEnglish = /^(en(?:[-_].+)?|english)$/i.test(bulletin.data?.source_language || "");
  const nativeChinese = isPredominantlyChinese(bulletin.data?.markdown || bulletin.data?.tldr || "");
  const requestedLanguage = params.get("lang");
  const lang = requestedLanguage != null ? (requestedLanguage === "original" ? null : requestedLanguage) : preferred === "en" && !nativeEnglish ? "en" : zh && !nativeChinese ? "zh" : null;
  const setLang = navigation.setLanguage;
  const translations = bulletin.data?.content_translations ?? [];
  const translation = useQuery({
    queryKey: ["translation", itemId, lang],
    queryFn: () => api.getTranslation(itemId, lang!),
    enabled: lang != null && Number.isInteger(itemId) && !!bulletin.data,
    retry: false,
    refetchInterval: (query) => query.state.data && ["queued", "processing"].includes(query.state.data.status) ? 3000 : false,
  });
  const requestEdition = useMutation({
    mutationFn: (code: string) => api.requestTranslation(itemId, code),
    onSuccess: (data, code) => {
      if (data.status === "original") {
        setLang(null);
        return;
      }
      setLang(code);
      qc.invalidateQueries({ queryKey: ["bulletin", itemId] });
      qc.invalidateQueries({ queryKey: ["translation", itemId, code] });
    },
  });
  const requestLanguage = (code: string) => {
    if (!authed) return;
    if (code === "zh" && nativeChinese) { setLang(null); return; }
    if (code === "zh" && zh) { requestEdition.mutate(code); return; }
    const label = languageLabel(code);
    if (confirm(zh ? `生成${label}全文？生成一次后所有人共用。` : `Generate a ${label} edition of the full summary? It runs once and is then shared.`)) requestEdition.mutate(code);
  };
  useEffect(() => {
    if (!authed || preferred === "auto" || (zh && nativeChinese) || lang !== preferred || askedEditions.current.has(`${itemId}:${preferred}`)) return;
    if (translations.some((row) => row.lang === preferred)) return;
    if (!bulletin.data) return;
    askedEditions.current.add(`${itemId}:${preferred}`);
    requestEdition.mutate(preferred);
  }, [authed, preferred, zh, nativeChinese, lang, translations, bulletin.data, itemId, requestEdition]);
  const chineseBrief = lang === "zh" && !nativeChinese;
  const briefLang = chineseBrief ? "zh" : lang === "en" ? "en" : undefined;
  const briefStatus = briefLang === "zh" ? bulletin.data?.reading_summary_zh?.status : briefLang === "en" ? bulletin.data?.reading_summary_en?.status : bulletin.data?.reading_summary.status;
  useEffect(() => {
    const key = `${itemId}:${briefLang || "source"}`;
    if (!authed) return;
    if (briefStatus === "missing" && !attempted.current.has(key)) {
      attempted.current.add(key);
      preparation.mutate({ id: itemId, lang: briefLang });
    }
  }, [authed, itemId, briefLang, briefStatus]); // A missing concise brief is prepared once; errors require an explicit retry.
  useEffect(() => { setPrintFull(false); }, [itemId]);

  const save = useMutation({
    mutationFn: () => api.addItems([bulletin.data!.source_url]),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bulletin"] }); qc.invalidateQueries({ queryKey: ["items"] }); },
  });
  if (bulletin.isLoading) return <LoadingState label={zh ? "正在打开阅读稿…" : "Opening your reading edition…"} />;
  if (bulletin.isError || !bulletin.data) return <ErrorState message={zh ? "这篇简报暂时无法打开。" : "This bulletin could not be loaded."} onRetry={() => bulletin.refetch()} />;
  const item = bulletin.data;
  const edition = lang != null && translation.data?.status === "done" ? translation.data : null;
  const editionStructured = (edition?.structured ?? {}) as Record<string, unknown>;
  const editionPoints = edition ? richestPoints(editionStructured) : [];
  const editionOverview = typeof editionStructured.tldr === "string" ? editionStructured.tldr : "";
  const pageTitle = edition && typeof editionStructured.headline === "string" && editionStructured.headline ? editionStructured.headline : item.source_title;
  const waitingEdition = lang != null && !edition && translation.data?.status !== "error";
  const failedEdition = lang != null && translation.data?.status === "error";
  const glancePoints = edition ? editionPoints : lang == null ? item.key_point_details : item.bulletin_points;
  const glanceOverview = edition ? editionOverview : lang == null ? item.tldr : item.bulletin_overview;
  const brief = briefLang === "zh" ? item.reading_summary_zh : briefLang === "en" ? item.reading_summary_en : item.reading_summary;
  const summary = brief?.content ?? null;
  const preparing = (preparation.isPending && preparation.variables?.id === itemId && preparation.variables.lang === briefLang) || brief?.status === "processing";
  const notesMarkdown = edition ? edition.markdown : item.markdown;
  const summaryText = summary ? [summary.lead, ...summary.sections.map((section) => section.body), summary.conclusion].join(" ") : item.tldr;
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
  return <div className="reading-edition content-reader">
    <div className="reader-screen screen-only">
      <ReaderHeader title={pageTitle} source={item.author || item.channel?.title || item.platform} sourceUrl={item.source_url} sourceLink={item.channel ? `/channels/${item.channel.id}` : undefined} thumbnail={item.thumbnail} zh={zh} backTo={backTo} backState={navigation.backState}
        meta={<><span>{dateLabel(item.published_at || item.created_at, zh)}</span><span>{readingMinutes(edition?.markdown || summaryText)} {zh ? "分钟阅读" : "min read"}</span><span>{item.platform}</span></>}
        actions={authed ? <Button variant="outline" className="min-h-11" disabled={item.saved || save.isPending} onClick={() => save.mutate()}>{item.saved ? <Check size={15} /> : <Bookmark size={15} />}{item.saved ? (zh ? "已加入知识库" : "In library") : (zh ? "加入知识库" : "Save to library")}</Button> : <Link to="/login" state={{ returnTo: location.pathname + location.search }} className="reader-control">{zh ? "登录后收藏" : "Sign in to save"}</Link>}
        more={<>
          <Select value={printFull ? "full" : "summary"} onChange={event => setPrintFull(event.target.value === "full")} aria-label={zh ? "PDF 内容" : "PDF contents"}><option value="summary">{zh ? "简报与精炼概括" : "Overview and summary"}</option><option value="full">{zh ? "包含完整笔记" : "Include full notes"}</option></Select>
          <Button variant="outline" disabled={printing || waitingEdition || (!summary && !printFull)} onClick={exportPdf}><FileDown size={15} />{printing ? (zh ? "正在准备…" : "Preparing…") : (zh ? "导出 PDF" : "Export PDF")}</Button>
          <Link to={`/items/${item.id}?${new URLSearchParams({ ...Object.fromEntries(params), workspace: "1", from: backTo })}`} state={location.state} className="reader-control">{zh ? "笔记与管理" : "Notes & tools"}</Link>
        </>}
      />
      {(save.isError || printError) && <p role="alert" className="mb-4 text-sm text-danger">{save.isError ? String(save.error) : zh ? "内容尚未加载完毕，请稍后重试导出。" : "Content is still loading. Please try exporting again."}</p>}
      <ContentLanguageBar active={lang} translations={translations} authed={authed} zhUi={zh} nativeChinese={nativeChinese} nativeEnglish={nativeEnglish} busy={requestEdition.isPending} onSelect={setLang} onRequest={requestLanguage} />
      <ReaderTabs view={view} onChange={setView} zh={zh}>
        <div className="content-reader-grid">
          <div className="content-reader-body">
            {view === "overview" && <>
              {waitingEdition && <p role="status" className="mb-4 text-sm text-muted-foreground">{zh ? "所选语言版本准备中，暂时显示已有概览。" : "This language is being prepared. Showing the available overview."}</p>}
              {failedEdition && <p role="alert" className="mb-4 text-sm text-danger">{zh ? "翻译失败，请稍后重试。" : "Translation failed. Please try again."}</p>}
              <ReaderOverview key={`${itemId}:${lang}`} intro={glanceOverview || item.summary || item.tldr} points={glancePoints.map(point => <>{point.text}{point.timestamp !== null && <a href={sourceAt(item.source_url, point.timestamp)} target="_blank" rel="noreferrer" className="reader-citation ml-2">{timestampLabel(point.timestamp)}</a>}</>)} zh={zh} />
            </>}
            {view === "summary" && <>
              <div className="reader-detail-toggle" role="group" aria-label={zh ? "精读深度" : "Reading depth"}>
                <button className="reader-control" aria-pressed={!fullNotes} onClick={() => setFullNotes(false)}>{zh ? "精炼概括" : "Concise summary"}</button>
                <button className="reader-control" aria-pressed={fullNotes} onClick={() => setFullNotes(true)}>{zh ? "完整笔记" : "Full notes"}</button>
              </div>
              {!fullNotes && (summary ? <SummaryBody summary={summary} source={item.source_url} zh={zh || chineseBrief} /> : <div className="reader-preparing" role="status"><BookOpen size={18} /><div><p>{preparing ? (zh ? "正在整理精炼概括…" : "Preparing the concise summary…") : (zh ? "精炼概括暂未就绪" : "The concise summary is not ready yet")}</p><p className="mt-2 text-sm">{zh ? "可先阅读概览或完整笔记。" : "You can read the overview or full notes."}</p>{!preparing && authed && <Button variant="outline" className="mt-3" onClick={() => preparation.mutate({ id: itemId, lang: briefLang })}>{zh ? "重试" : "Retry summary"}</Button>}</div></div>)}
              {fullNotes && (waitingEdition || failedEdition ? <div className="reader-preparing" role="status"><div><p>{failedEdition ? (zh ? "翻译失败。" : "Translation failed.") : (zh ? "完整笔记翻译中…" : "Preparing the full notes…")}</p>{failedEdition && authed && <Button className="mt-3" variant="outline" onClick={() => requestEdition.mutate(lang!)}>{zh ? "重试" : "Retry"}</Button>}</div></div> : <Suspense fallback={<LoadingState />}>{authed && !edition ? <MediaSummaryNotes itemId={itemId} markdown={notesMarkdown} /> : <FullMarkdown markdown={notesMarkdown} highlights={[]} source="summary" readOnly onCreate={noOp} onUpdateNote={noOp} onDelete={noOp} className="prose-sr reader-prose" />}</Suspense>)}
            </>}
            {view === "sources" && <>
              <section className="reader-section !pt-0"><h2>{zh ? "原始来源" : "Original source"}</h2><p className="reader-prose mt-3">{item.background}</p><a href={item.source_url} target="_blank" rel="noreferrer" className="reader-control mt-2">{zh ? "打开原始来源" : "Open original source"}<ArrowUpRight size={14} /></a></section>
              <details className="my-6 border-y py-3"><summary className="reader-control">{zh ? `引用（${item.quotes.length}）` : `Quotes (${item.quotes.length})`}</summary>{item.quotes.map((quote, index) => <blockquote className="reader-quote" key={index}><p>“{quote.text}”</p><footer>{quote.speaker}{quote.timestamp !== null && <a href={sourceAt(item.source_url, quote.timestamp)} target="_blank" rel="noreferrer"> · {timestampLabel(quote.timestamp)} ↗</a>}</footer></blockquote>)}{!item.quotes.length && <p className="p-3 text-sm text-muted-foreground">{zh ? "未提取单独引文，可直接阅读逐字稿。" : "No separate quotes were extracted. You can read the transcript below."}</p>}</details>
              <Suspense fallback={<LoadingState />}><MediaSourceContent itemId={itemId} zh={zh} /></Suspense>
            </>}
          </div>
          {view === "summary" && !fullNotes && summary && <ReaderOutline sections={summary.sections.map((section, index) => ({ id: `section-${index}`, title: section.heading }))} zh={zh} />}
        </div>
      </ReaderTabs>
    </div>
    <article className="reading-print">
      <p className="print-kicker">STREAM-REDUCE / THE BULLETIN</p><h1>{pageTitle}</h1><p className="print-meta">{item.author} · {dateLabel(item.published_at || item.created_at, zh)}</p>
      {glanceOverview && <p className="print-lead">{glanceOverview}</p>}
      <ul className="print-bulletin">{glancePoints.map((point, index) => <li key={index}>{point.text}</li>)}</ul>
      {summary && <div className="print-detailed"><SummaryBody summary={summary} source={item.source_url} zh={zh} print /></div>}
      {printFull && <div className="print-detailed print-full-notes"><h2>{zh ? "完整逐段内容" : "Full notes"}</h2><Suspense fallback={<p>{zh ? "正在加载完整内容…" : "Loading full notes…"}</p>}><FullMarkdown markdown={notesMarkdown} highlights={[]} source="summary" readOnly onCreate={noOp} onUpdateNote={noOp} onDelete={noOp} className="prose-sr reader-prose" /></Suspense></div>}
      <p className="print-source">{zh ? "来源" : "Source"}: {item.source_title}<br /><a href={item.source_url}>{item.source_url}</a></p>
    </article>
  </div>;
}
