import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Bookmark,
  ExternalLink,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { Button, Select, Spinner } from "@/components/ui";
import { useMe } from "@/lib/auth";
import {
  rssApi,
  rssDate,
  completenessLabel,
  levelLabel,
  type RssDetail as Detail,
  type RssBody,
} from "@/lib/rss";

export function RssDetail() {
  const { id } = useParams();
  const me = useMe();
  const client = useQueryClient();
  const [lang, setLang] = useState(
    me.data?.user?.preferred_language === "zh" ? "zh" : "original",
  );
  const [showBody, setShowBody] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const article = useQuery({
    queryKey: ["rss", "article", id, lang],
    queryFn: () => rssApi<Detail>(`/articles/${id}?lang=${lang}`),
    refetchInterval: (q) =>
      ["done", "missing"].includes(q.state.data?.status || "") ? false : 10000,
  });
  const body = useQuery({
    queryKey: ["rss", "body", id],
    queryFn: () => rssApi<RssBody>(`/articles/${id}/body`),
    enabled: showBody,
  });
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["rss"] }),
        client.invalidateQueries({ queryKey: ["bulletin", "feed"] }),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (article.isLoading)
    return (
      <div className="flex items-center gap-2 p-10">
        <Spinner />
        正在打开文章…
      </div>
    );
  if (article.error || !article.data)
    return (
      <p role="alert" className="p-6 text-danger">
        {article.error?.message || "文章不存在"}
      </p>
    );
  const a = article.data;
  const edition =
    a.editions.find((e) => e.lang === lang)?.content ||
    a.editions.find((e) => e.lang === "original")?.content;
  return (
    <div className="mx-auto max-w-4xl pb-16">
      <Link
        to="/bulletin"
        className="mb-6 inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft size={16} />
        Bulletin
      </Link>
      <article className="rounded-lg border bg-card px-5 py-7 sm:px-10 sm:py-10">
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          {a.sources.map((s) => (
            <Link
              key={s.id}
              to={`/subscriptions?tab=articles&source=${s.id}`}
              className="hover:text-primary"
            >
              {s.title}
            </Link>
          ))}
          <time>{rssDate(a.published_at)}</time>
          <span>{Math.max(1, Math.ceil(a.word_count / 250))} 分钟阅读</span>
          <span className={a.completeness === "partial" ? "text-warning" : ""}>
            {completenessLabel(a.completeness)}
          </span>
        </div>
        <h1 className="max-w-3xl text-2xl font-semibold leading-tight tracking-tight sm:text-4xl">
          {edition?.headline || a.title}
        </h1>
        {edition && edition.headline !== a.title && (
          <p className="mt-3 text-sm text-muted-foreground">{a.title}</p>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-3 border-b pb-5">
          <a
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-2 text-sm text-primary"
          >
            打开原文
            <ExternalLink size={14} />
          </a>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await rssApi(
                  `/articles/${id}`,
                  { saved: !a.read.saved },
                  "PATCH",
                );
              })
            }
          >
            <Bookmark
              size={15}
              className={a.read.saved ? "fill-current" : ""}
            />
            {a.read.saved ? "已收藏" : "收藏"}
          </Button>
          <Select
            aria-label="概括语言"
            className="ml-auto min-h-11 w-32"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
          >
            <option value="original">原文语言</option>
            <option value="zh">中文</option>
          </Select>
        </div>
        {error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        )}
        {lang === "zh" &&
          !a.editions.some((e) => e.lang === "zh") &&
          edition && (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              中文版本正在准备，当前显示原文语言。
            </p>
          )}
        {edition ? (
          <>
            <section className="mt-7" aria-label="文章简报">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">简报</h2>
                <span className="text-xs text-muted-foreground">
                  {levelLabel(edition.level)}
                  {edition.based_on_excerpt ? " · 基于摘录" : ""}
                </span>
              </div>
              {edition.based_on_excerpt && (
                <p className="mb-4 rounded-md bg-warning/10 p-3 text-sm text-warning">
                  尚未获取完整正文。以下简报仅基于已保存摘录。
                </p>
              )}
              <p className="text-base leading-8">{edition.intro}</p>
              {edition.points.length > 0 && (
                <ul className="mt-5 list-disc space-y-3 pl-5 text-base leading-7">
                  {edition.points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
            </section>
            {edition.sections.length > 0 ? (
              <section className="mt-9 border-t pt-7">
                <h2 className="mb-5 text-lg font-semibold">精炼概括</h2>
                {edition.sections.length > 3 && (
                  <nav
                    aria-label="文章主题"
                    className="mb-7 flex flex-wrap gap-2"
                  >
                    {edition.sections.map((s, i) => (
                      <a
                        key={i}
                        href={`#rss-section-${i}`}
                        className="rounded-md bg-muted/60 px-3 py-2 text-sm hover:text-primary"
                      >
                        {s.title}
                      </a>
                    ))}
                  </nav>
                )}
                <div className="space-y-7">
                  {edition.sections.map((s, i) => (
                    <section
                      key={i}
                      id={`rss-section-${i}`}
                      className="scroll-mt-20"
                    >
                      <h3 className="mb-2 font-semibold">{s.title}</h3>
                      <p className="whitespace-pre-line text-base leading-8">
                        {s.text}
                      </p>
                    </section>
                  ))}
                </div>
              </section>
            ) : !edition.based_on_excerpt ? (
              <p className="mt-7 border-t pt-5 text-sm text-muted-foreground">
                简报已覆盖主要信息。
              </p>
            ) : null}
          </>
        ) : (
          <section className="py-9">
            <h2 className="font-semibold">
              {a.status === "missing"
                ? "暂时没有可读取的正文"
                : "正文与概括正在准备中"}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {a.error ||
                "文章会先保存正文，再生成简报和精炼概括。可以稍后回来，或先打开原文。"}
            </p>
          </section>
        )}
        <section className="mt-9 border-t pt-5">
          <button
            onClick={() => setShowBody(!showBody)}
            className="flex min-h-11 w-full items-center justify-between gap-3 text-left font-medium"
            aria-expanded={showBody}
          >
            已保存原文
            <ChevronDown size={18} className={showBody ? "rotate-180" : ""} />
          </button>
          {showBody && (
            <div className="mt-5">
              {body.isLoading ? (
                <Spinner />
              ) : body.error ? (
                <p role="alert" className="text-sm text-warning">
                  {body.error.message}
                </p>
              ) : body.data ? (
                <>
                  <p className="mb-5 break-all text-xs text-muted-foreground">
                    {completenessLabel(body.data.completeness)} · 版本{" "}
                    {a.body_version} · {body.data.method}
                    <br />
                    <a
                      className="underline"
                      target="_blank"
                      rel="noreferrer"
                      href={body.data.source_url}
                    >
                      {body.data.source_url}
                    </a>
                  </p>
                  {body.data.paragraphs.map((p) => (
                    <div
                      key={p.id}
                      className="rss-original mb-5 rounded-md p-2"
                    >
                      <div className="prose prose-sm max-w-none break-words dark:prose-invert">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            img: () => null,
                            a: ({ children, href }) => (
                              <a href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {p.text}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          )}
        </section>
        <div className="mt-5 flex flex-wrap gap-2 border-t pt-5">
          <Button
            disabled={busy}
            variant="outline"
            size="sm"
            onClick={() =>
              void action(async () => {
                await rssApi(`/articles/${id}/retry`, {});
              })
            }
          >
            <RefreshCw size={13} />
            重试概括
          </Button>
          <Button
            disabled={busy}
            variant="ghost"
            size="sm"
            onClick={() =>
              void action(async () => {
                await rssApi(`/articles/${id}/retry`, { refetch: true });
              })
            }
          >
            重新获取正文
          </Button>
        </div>
      </article>
    </div>
  );
}
