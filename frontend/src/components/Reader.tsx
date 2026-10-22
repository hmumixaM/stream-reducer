import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams, useNavigationType, type LinkProps } from "react-router-dom";
import { ArrowLeft, ExternalLink, List } from "lucide-react";
import { SourceCover } from "@/components/SourceCover";
import { cn } from "@/lib/utils";

export type ReaderView = "overview" | "summary" | "sources";
export function safeReaderReturn(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) return null;
  return /^\/(?:$|browse(?:[?#]|$)|articles(?:[?#]|$)|bulletin(?:[?#]|$)|library(?:[?#]|$)|timeline(?:[?#]|$)|search(?:[?#]|$)|collections(?:[/#?]|$)|channels\/\d+(?:[?#]|$)|folders\/\d+(?:[?#]|$)|subscriptions(?:[?#]|$))/.test(value) ? value : null;
}
const isReader = (path: string) => /^\/(?:items|bulletin|rss\/articles)\/\d+(?:[?#]|$)/.test(path);

/** Carry the originating list and scroll position through every reading entry. */
export function ReaderLink({ to, onClick, state, ...props }: LinkProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const destination = typeof to === "string" ? to : to.pathname || "";
  let targetTo = to;
  if (typeof to === "string" && isReader(destination)) {
    const origin = isReader(location.pathname) ? location.state?.readerFrom || new URLSearchParams(location.search).get("from") : location.pathname + location.search + location.hash;
    const from = safeReaderReturn(origin);
    if (from) {
      const url = new URL(to, window.location.origin);
      url.searchParams.set("from", from);
      targetTo = url.pathname + url.search + url.hash;
    }
  }
  return <Link {...props} to={targetTo} state={state} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.reloadDocument || (props.target && props.target !== "_self") || !isReader(destination)) return;
    event.preventDefault();
    const origin = isReader(location.pathname)
      ? location.state
      : { readerFrom: location.pathname + location.search + location.hash, readerScrollY: window.scrollY };
    navigate(targetTo, { replace: props.replace, relative: props.relative, preventScrollReset: props.preventScrollReset, state: { ...origin, ...state } });
  }} />;
}

export function useReaderNavigation(fallback: string) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const backTo = safeReaderReturn(location.state?.readerFrom) || safeReaderReturn(params.get("from")) || fallback;
  const selected = params.get("view");
  const view: ReaderView = selected === "overview" || selected === "sources" ? selected : "summary";
  const setView = (next: ReaderView) => setParams(previous => {
    const p = new URLSearchParams(previous);
    p.set("view", next);
    p.delete("detail");
    return p;
  }, { state: location.state });
  const setLanguage = (language: string | null) => setParams(previous => {
    const p = new URLSearchParams(previous);
    p.set("lang", language || "original");
    return p;
  }, { replace: true, state: location.state });
  return { backTo, backState: { readerRestoreY: location.state?.readerScrollY }, view, setView, params, setParams, setLanguage, location };
}

export function ReaderScrollRestoration() {
  const location = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    const y = location.state?.readerRestoreY;
    if (typeof y !== "number" || !Number.isFinite(y) || y < 0) {
      if (!location.hash && navigationType !== "POP") window.scrollTo(0, 0);
      return;
    }
    let attempts = 0;
    const restore = () => {
      window.scrollTo(0, y);
      if (Math.abs(window.scrollY - y) < 2 || ++attempts > 30) clearInterval(timer);
    };
    const timer = window.setInterval(restore, 50);
    const cancel = () => clearInterval(timer);
    window.addEventListener("wheel", cancel, { once: true });
    window.addEventListener("touchstart", cancel, { once: true });
    return () => { cancel(); window.removeEventListener("wheel", cancel); window.removeEventListener("touchstart", cancel); };
    // Query changes are reading controls/filter edits, not a new page.
  }, [location.pathname]);
  return null;
}

export function ReaderHeader({ title, originalTitle, source, sourceUrl, sourceLink, thumbnail, meta, backTo, backState, actions, more, zh }: {
  title: string; originalTitle?: string; source: string; sourceUrl: string; sourceLink?: string;
  thumbnail?: string | null; meta: ReactNode; backTo: string; backState?: unknown;
  actions?: ReactNode; more?: ReactNode; zh: boolean;
}) {
  return <header className="content-reader-header">
    <div className="content-reader-topline">
      <Link to={backTo} state={backState} className="reader-control"><ArrowLeft size={16} aria-hidden />{zh ? "返回列表" : "Back to list"}</Link>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <a href={sourceUrl} target="_blank" rel="noreferrer" className="reader-control"><ExternalLink size={15} aria-hidden />{zh ? "原始来源" : "Original source"}</a>
        {more && <details className="reader-more"><summary className="reader-control">{zh ? "更多" : "More"}</summary><div className="reader-more-content">{more}</div></details>}
      </div>
    </div>
    <div className="content-reader-byline">
      {sourceLink ? <Link to={sourceLink}>{source}</Link> : <span>{source}</span>}
      {meta}
    </div>
    <div className="source-heading">
      <div className="min-w-0"><h1>{title}</h1>{originalTitle && originalTitle !== title && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{originalTitle}</p>}</div>
      <SourceCover src={thumbnail} title={title} author={source} href={sourceUrl} />
    </div>
  </header>;
}

export function ReaderTabs({ view, onChange, zh, children }: { view: ReaderView; onChange: (view: ReaderView) => void; zh: boolean; children: ReactNode }) {
  const id = useId();
  const tabs: { value: ReaderView; label: string }[] = [
    { value: "overview", label: zh ? "概览" : "Overview" },
    { value: "summary", label: zh ? "精读" : "Read" },
    { value: "sources", label: zh ? "原文与引用" : "Original & sources" },
  ];
  return <>
    <div className="content-reader-tabs" role="tablist" aria-label={zh ? "阅读层次" : "Reading views"}>
      {tabs.map((tab, index) => <button key={tab.value} type="button" role="tab" id={`${id}-${tab.value}`} aria-controls={`${id}-panel`} aria-selected={view === tab.value} tabIndex={view === tab.value ? 0 : -1} className={cn("content-reader-tab", view === tab.value && "is-active")} onClick={() => onChange(tab.value)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        onChange(tabs[next].value);
        document.getElementById(`${id}-${tabs[next].value}`)?.focus();
      }}>{tab.label}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view}`} tabIndex={0} className="content-reader-panel">{children}</div>
  </>;
}

export function ReaderOutline({ sections, zh }: { sections: { id: string; title: string }[]; zh: boolean }) {
  if (!sections.length) return null;
  const links = <ol>{sections.map(section => <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>)}</ol>;
  return <>
    <details className="reader-outline-mobile"><summary className="reader-control"><List size={16} aria-hidden />{zh ? "本篇目录" : "In this reading"}</summary>{links}</details>
    <aside className="reader-outline-desktop"><nav aria-label={zh ? "本篇目录" : "In this reading"}><h2>{zh ? "本篇目录" : "In this reading"}</h2>{links}</nav></aside>
  </>;
}

export function ReaderOverview({ intro, points, zh }: { intro: string; points: ReactNode[]; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="reader-overview">
    <p className="reader-lead">{intro}</p>
    <ul>{(expanded ? points : points.slice(0, 5)).map((point, i) => <li key={i}>{point}</li>)}</ul>
    {points.length > 5 && <button type="button" className="reader-control mt-4" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? (zh ? "收起要点" : "Fewer points") : (zh ? `展开其余 ${points.length - 5} 条要点` : `Show ${points.length - 5} more points`)}</button>}
  </div>;
}
