import { updateMetadata } from "@/lib/seo";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bookmark, ExternalLink, FileDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import { ErrorState, LoadingState } from "@/components/shell";
import { ContentLanguageBar, languageLabel } from "@/components/ContentLanguage";
import { ReaderHeader, ReaderTabs, ReaderOutline, ReaderOverview, useReaderNavigation } from "@/components/Reader";
import { useMe } from "@/lib/auth";
import { dateLabel, readingMinutes } from "@/lib/bulletin";
import { rssApi, type RssDetail as Detail, type RssBody } from "@/lib/rss";

export function RssDetail() {
  const { id } = useParams();
  const me = useMe();
  const client = useQueryClient();
  const authed = !!me.data?.user;
  const zh = me.data?.user?.preferred_language === "zh";
  const navigation = useReaderNavigation(authed ? "/bulletin" : "/articles");
  const { view, setView, params, location } = navigation;
  const lang = params.get("lang") || (me.data?.user?.preferred_language === "en" ? "en" : zh ? "zh" : "original");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const publicRead = async <T,>(suffix: string): Promise<T> => {
    const response = await fetch(`/api/public/articles/${id}${suffix}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Article unavailable");
    return data as T;
  };
  const article = useQuery({
    queryKey: ["rss", "article", id, lang, me.data?.user?.id],
    queryFn: () => authed ? rssApi<Detail>(`/articles/${id}?lang=${encodeURIComponent(lang)}`).catch(() => publicRead<Detail>("")) : publicRead<Detail>(""),
    refetchInterval: q => !["done", "missing", "error"].includes(q.state.data?.status || "") ? 10000 : false,
  });
  const body = useQuery({
    queryKey: ["rss", "body", id, me.data?.user?.id],
    queryFn: () => authed ? rssApi<RssBody>(`/articles/${id}/body`).catch(() => publicRead<RssBody>("/body")) : publicRead<RssBody>("/body"),
    enabled: view === "sources",
  });
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); await Promise.all([client.invalidateQueries({ queryKey: ["rss"] }), client.invalidateQueries({ queryKey: ["bulletin", "feed"] })]); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const a = article.data;
    if (!a) return;
    const edition = a.editions.find(e => e.lang === "original")?.content;
    updateMetadata(`${edition?.headline || a.title} | Stream Reducer`, (edition?.intro || a.title).slice(0, 180), `https://reducer.xgoose.org/rss/articles/${a.id}`, a.status === "done");
  }, [article.data]);
  if (article.isLoading) return <LoadingState label={zh ? "正在打开文章…" : "Opening article…"} />;
  if (article.isError || !article.data) return <ErrorState message={article.error?.message || (zh ? "文章不存在" : "Article unavailable")} onRetry={() => article.refetch()} />;
  const a = article.data;
  const selectedEdition = a.editions.find(e => e.lang === lang)?.content;
  const edition = selectedEdition || a.editions.find(e => e.lang === "original")?.content;
  const incomplete = a.completeness === "partial" || edition?.based_on_excerpt;
  const summaryText = edition ? [edition.intro, ...edition.sections.map(s => s.text)].join(" ") : "";
  const originalStatus = incomplete ? (zh ? "仅有摘录" : "Excerpt only") : a.completeness === "full" ? (zh ? "原文已保存" : "Original available") : (zh ? "原文待准备" : "Original pending");
  return <div className="content-reader article-reader">
    <ReaderHeader title={edition?.headline || a.title} originalTitle={a.title} source={a.sources[0]?.title || a.author || new URL(a.url).hostname} sourceUrl={a.url} sourceLink={a.sources[0] ? `/subscriptions?tab=articles&source=${a.sources[0].id}` : undefined} zh={zh} backTo={navigation.backTo} backState={navigation.backState}
      meta={<>{a.published_at && <span>{dateLabel(a.published_at, zh)}</span>}<span>{readingMinutes(summaryText)} {zh ? "分钟阅读" : "min read"}</span><span>{zh ? "文章" : "Article"}</span><span className={incomplete ? "text-warning" : ""}>{originalStatus}</span></>}
      actions={authed ? <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void action(async () => { await rssApi(`/articles/${id}`, { saved: !a.read.saved }, "PATCH"); })}><Bookmark size={15} className={a.read.saved ? "fill-current" : ""} />{a.read.saved ? (zh ? "已收藏" : "Saved") : (zh ? "收藏" : "Save article")}</Button> : <Link to="/login" state={{ returnTo: location.pathname + location.search }} className="reader-control">{zh ? "登录后收藏" : "Sign in to save"}</Link>}
      more={<>
        <Button variant="outline" onClick={() => window.print()}><FileDown size={15} />{zh ? "导出当前阅读" : "Export current view"}</Button>
        {authed && <><Button variant="outline" disabled={busy} onClick={() => void action(async () => { await rssApi(`/articles/${id}/retry`, {}); })}><RefreshCw size={15} />{zh ? "重试概括" : "Retry summary"}</Button><Button variant="ghost" disabled={busy} onClick={() => void action(async () => { await rssApi(`/articles/${id}/retry`, { refetch: true }); })}>{zh ? "重新获取正文" : "Fetch original again"}</Button></>}
      </>}
    />
    <div className="screen-only"><ContentLanguageBar active={lang === "original" ? null : lang} translations={a.editions.filter(e => e.lang !== "original").map(e => ({ lang: e.lang, status: "done" }))} authed={authed} busy={busy} zhUi={zh} allowMoreLanguages={false} onSelect={navigation.setLanguage} onRequest={navigation.setLanguage} /></div>
    {error && <p role="alert" className="my-4 text-sm text-danger">{error}</p>}
    {lang !== "original" && !selectedEdition && <p role="status" className="my-4 text-sm text-muted-foreground">{zh ? `${languageLabel(lang)}版本暂未就绪，当前显示原文语言。` : `The ${languageLabel(lang)} edition is not available yet. Showing the original language.`}<button className="reader-control ml-2" onClick={() => article.refetch()}>{zh ? "检查更新" : "Check again"}</button></p>}
    {incomplete && <p className="my-4 rounded-md border border-warning/30 p-3 text-sm text-warning">{zh ? "当前仅保存摘录，概括基于已有内容。" : "Only an excerpt is available. This summary covers the saved content."}</p>}
    <ReaderTabs view={view} onChange={setView} zh={zh}>
      <div className="content-reader-grid">
        <div className="content-reader-body">
          {view !== "sources" && !edition && <div className="reader-preparing" role="status">{a.error || (zh ? "正文与概括暂未就绪，可以先打开原始来源。" : "This reading is not ready yet. You can open the original source.")}</div>}
          {view === "overview" && edition && <ReaderOverview key={`${id}:${lang}`} intro={edition.intro} points={edition.points} zh={zh} />}
          {view === "summary" && edition && <>
            <p className="reader-lead">{edition.intro}</p>
            {edition.sections.map((section, i) => <section key={i} id={`article-section-${i}`} className="reader-section"><h2 className="mb-3">{section.title}</h2><p className="reader-prose whitespace-pre-line">{section.text}</p></section>)}
            {!edition.sections.length && <><p className="mt-6 text-sm text-muted-foreground">{zh ? "这篇内容较短，以下要点已覆盖主要信息。" : "This is a short piece. These points cover the main ideas."}</p><ReaderOverview intro="" points={edition.points} zh={zh} /></>}
          </>}
          {view === "sources" && <>
            <h2 className="mb-4 text-xl font-semibold">{zh ? "已保存原文" : "Saved original"}</h2>
            <a href={a.url} target="_blank" rel="noreferrer" className="reader-control mb-5"><ExternalLink size={15} />{zh ? "打开原始来源" : "Open original source"}</a>
            {body.isLoading ? <LoadingState /> : body.isError ? <ErrorState message={body.error.message} onRetry={() => body.refetch()} /> : body.data && <>
              {body.data.warning && <p className="mb-5 text-sm text-warning">{body.data.warning}</p>}
              <div className="reader-prose">{body.data.paragraphs.map(paragraph => <div key={paragraph.id} className="mb-5"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{paragraph.text}</ReactMarkdown></div>)}</div>
              {!body.data.paragraphs.length && <p className="reader-prose whitespace-pre-line">{body.data.text || (zh ? "没有可显示的正文。" : "No original text is available.")}</p>}
            </>}
          </>}
        </div>
        {view === "summary" && edition && <ReaderOutline sections={edition.sections.map((section, i) => ({ id: `article-section-${i}`, title: section.title }))} zh={zh} />}
      </div>
    </ReaderTabs>
  </div>;
}
