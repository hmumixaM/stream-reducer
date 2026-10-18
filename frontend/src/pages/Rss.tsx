import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark,
  Check,
  ExternalLink,
  RefreshCw,
  Rss as RssIcon,
  Plus,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import { Button, Input, Select, Spinner } from "@/components/ui";
import { useMe } from "@/lib/auth";
import {
  rssApi,
  rssDate,
  completenessLabel,
  levelLabel,
  type RssArticle,
  type RssSource,
  type RssStatus,
  type RssPreview,
} from "@/lib/rss";

const backfillLabel: Record<string, string> = {
  pending: "等待回填",
  running: "正在回填",
  complete: "已覆盖三个月起点",
  gap: "已取到可用历史，可能不全",
  paused: "历史回填已暂停",
};
export function Rss() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("view") || "articles";
  const me = useMe();
  const lang = me.data?.user?.preferred_language === "zh" ? "zh" : "original";
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [resolved, setResolved] = useState<{
    title?: string;
    feed_url?: string;
    choices?: { url: string; title: string }[];
  } | null>(null);
  const [preview, setPreview] = useState<RssPreview | null>(null);
  const [opml, setOpml] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["rss", "status"],
    queryFn: () => rssApi<RssStatus>("/status"),
    refetchInterval: 15000,
  });
  const sources = useQuery({
    queryKey: ["rss", "sources"],
    queryFn: () => rssApi<RssSource[]>("/sources"),
    refetchInterval: 15000,
  });
  const query = new URLSearchParams(params);
  query.set("lang", lang);
  query.delete("view");
  const articles = useQuery({
    queryKey: ["rss", "articles", query.toString()],
    queryFn: () =>
      rssApi<{ articles: RssArticle[]; has_more: boolean }>(
        `/articles?${query}`,
      ),
    enabled: tab !== "sources",
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (status.error) setError(status.error.message);
  }, [status.error]);
  const change = (key: string, value: string) => {
    const p = new URLSearchParams(params);
    value ? p.set(key, value) : p.delete(key);
    if (key !== "page") p.delete("page");
    setParams(p);
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ["rss"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const categories = [
    ...new Set(sources.data?.map((s) => s.category).filter(Boolean)),
  ];
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight">
            <RssIcon className="h-7 w-7 text-primary" />
            RSS
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            从来源阅读，保留正文，按信息量概括。
          </p>
        </div>
        <Button variant="outline" onClick={() => change("view", "sources")}>
          <Plus size={16} />
          关注来源
        </Button>
      </div>
      <nav aria-label="RSS 视图" className="flex gap-6 border-b">
        {[
          ["articles", "文章"],
          ["bulletin", "简报"],
          ["sources", "来源"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={`min-h-11 border-b-2 px-1 pb-3 text-sm ${tab === id ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground"}`}
            onClick={() => change("view", id)}
          >
            {label}
            {id === "sources" && sources.data ? ` ${sources.data.length}` : ""}
          </button>
        ))}
      </nav>
      {(status.data?.paused || status.data?.enabled === false) && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          RSS 后台处理已暂停，已保存文章仍可阅读。
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-danger/40 p-3 text-sm text-danger"
        >
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      {tab === "sources" ? (
        <>
          <section
            className="rounded-lg border bg-card p-4 sm:p-6"
            aria-label="添加 RSS 来源"
          >
            <h2 className="font-semibold">关注一个来源</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              支持 RSS / Atom、RSSHub 和 Folo 来源链接。只加入 reducer，不会在
              Folo 创建订阅。
            </p>
            <form
              className="mt-4 flex flex-col gap-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  setResolved(await rssApi("/resolve", { url }));
                });
              }}
            >
              <Input
                aria-label="来源或 RSS 链接"
                placeholder="粘贴来源或 RSS 链接"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setResolved(null);
                }}
                required
                className="min-h-11 flex-1"
              />
              <Input
                aria-label="来源分类"
                placeholder="分类（可选）"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="min-h-11 sm:w-36"
              />
              <Button
                className="min-h-11"
                disabled={busy || !url.trim()}
                type="submit"
              >
                {busy ? <Spinner /> : null}解析链接
              </Button>
            </form>
            {resolved?.choices ? (
              <div className="mt-4 space-y-2">
                <p className="text-sm">此网站提供多个 feed，请选择：</p>
                {resolved.choices.map((c) => (
                  <Button
                    key={c.url}
                    variant="outline"
                    className="h-auto min-h-11 max-w-full whitespace-normal break-all"
                    onClick={() => {
                      setUrl(c.url);
                      setResolved(null);
                    }}
                  >
                    {c.title}
                  </Button>
                ))}
              </div>
            ) : resolved?.title ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <div className="min-w-0">
                  <p className="font-medium">{resolved.title}</p>
                  <p className="break-all text-xs text-muted-foreground">
                    {resolved.feed_url}
                  </p>
                </div>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await rssApi("/sources", { url, category });
                      setNotice("已关注，正在获取文章");
                      setUrl("");
                      setResolved(null);
                    })
                  }
                >
                  关注
                </Button>
              </div>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t pt-4">
              {status.data?.folo_available && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      setOpml(null);
                      setPreview(await rssApi<RssPreview>("/import/folo", {}));
                    })
                  }
                >
                  从我的 Folo 导入
                </Button>
              )}
              <label className="cursor-pointer rounded-md border px-4 py-2 text-sm focus-within:ring-2 focus-within:ring-ring">
                导入 OPML
                <input
                  aria-label="导入 OPML 文件"
                  type="file"
                  accept=".opml,.xml,text/xml"
                  className="sr-only"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void action(async () => {
                        const text = await file.text();
                        setOpml(text);
                        setPreview(
                          await rssApi<RssPreview>("/import/opml", { text }),
                        );
                      });
                    e.target.value = "";
                  }}
                />
              </label>
              {status.data?.is_admin && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await rssApi("/control", {
                        paused: !status.data?.paused,
                      });
                    })
                  }
                >
                  {status.data.paused ? "恢复后台处理" : "暂停后台处理"}
                </Button>
              )}
            </div>
            {preview && (
              <div className="mt-4 rounded-md bg-muted/50 p-4">
                <p className="font-medium">
                  准备导入 {preview.sources.length} 个公开来源
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  保留分类，已关注的来源自动合并。首次尝试回填最近三个月。跳过{" "}
                  {preview.skipped} 个不支持或私有来源。
                </p>
                <div className="my-3 max-h-48 overflow-y-auto text-sm">
                  {preview.sources.map((s, i) => (
                    <p key={i}>
                      {s.category && `${s.category} / `}
                      {s.title}
                    </p>
                  ))}
                </div>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const result = await rssApi<{ imported: number }>(
                        opml ? "/import/opml" : "/import/folo",
                        { execute: true, ...(opml ? { text: opml } : {}) },
                      );
                      setNotice(
                        `已导入 ${result.imported} 个来源，正在获取文章`,
                      );
                      setPreview(null);
                    })
                  }
                >
                  导入这些来源
                </Button>
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  取消
                </Button>
              </div>
            )}
          </section>
          {sources.isLoading ? (
            <Spinner />
          ) : sources.error ? (
            <p role="alert">{sources.error.message}</p>
          ) : sources.data?.length === 0 ? (
            <p className="py-10 text-center text-muted-foreground">
              还没有关注来源。粘贴 RSS 链接，或导入 Folo / OPML 开始阅读。
            </p>
          ) : (
            <div className="space-y-6">
              {["", ...categories]
                .filter((cat) => sources.data?.some((s) => s.category === cat))
                .map((cat) => (
                  <section key={cat}>
                    <h2 className="mb-2 font-semibold">{cat || "未分类"}</h2>
                    <div className="divide-y rounded-lg border bg-card">
                      {sources
                        .data!.filter((s) => s.category === cat)
                        .map((s) => (
                          <div
                            key={s.id}
                            className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between"
                          >
                            <div className="min-w-0 flex-1">
                              <button
                                className="text-left font-semibold hover:text-primary"
                                onClick={() => {
                                  setParams({
                                    view: "articles",
                                    source: String(s.id),
                                  });
                                }}
                              >
                                {s.title}
                              </button>
                              <p className="mt-1 break-all text-xs text-muted-foreground">
                                {s.feed_url || s.url}
                              </p>
                              <p className="mt-2 text-xs text-muted-foreground">
                                {s.article_count} 篇文章 ·{" "}
                                {s.actual_provider || s.provider} · 上次更新{" "}
                                {s.last_checked_at
                                  ? new Date(s.last_checked_at).toLocaleString()
                                  : "等待更新"}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {backfillLabel[s.backfill_status] ||
                                  s.backfill_status}{" "}
                                · 目标从 {rssDate(s.backfill_since)} 起
                                {s.earliest_at
                                  ? ` · 最早获取 ${rssDate(s.earliest_at)}`
                                  : ""}
                              </p>
                              {s.last_error && (
                                <p className="mt-2 text-xs text-warning">
                                  {s.auth_error
                                    ? "Folo 需要重新连接，已尝试原始 RSS。 "
                                    : ""}
                                  {s.last_error}
                                </p>
                              )}
                              <div className="mt-3">
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                  分类
                                  <Input
                                    className="max-w-48"
                                    aria-label={`${s.title} 分类`}
                                    defaultValue={s.category}
                                    onBlur={(e) => {
                                      if (e.target.value !== s.category)
                                        void action(async () => {
                                          await rssApi(
                                            `/sources/${s.id}`,
                                            { category: e.target.value },
                                            "PATCH",
                                          );
                                        });
                                    }}
                                  />
                                </label>
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  void action(async () => {
                                    await rssApi(
                                      `/sources/${s.id}/refresh`,
                                      {},
                                    );
                                    setNotice(`已安排更新 ${s.title}`);
                                  })
                                }
                              >
                                <RefreshCw size={13} />
                                更新
                              </Button>
                              {status.data?.is_admin && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    void action(async () => {
                                      await rssApi(
                                        `/sources/${s.id}`,
                                        {
                                          backfill:
                                            s.backfill_status === "paused"
                                              ? "resume"
                                              : "pause",
                                        },
                                        "PATCH",
                                      );
                                    })
                                  }
                                >
                                  {s.backfill_status === "paused"
                                    ? "恢复回填"
                                    : "暂停回填"}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void action(async () => {
                                    await rssApi(
                                      `/sources/${s.id}`,
                                      undefined,
                                      "DELETE",
                                    );
                                    setNotice(
                                      "已取消关注，重新添加链接即可恢复",
                                    );
                                  })
                                }
                              >
                                取消关注
                              </Button>
                            </div>
                          </div>
                        ))}
                    </div>
                  </section>
                ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Select
              aria-label="筛选来源"
              value={params.get("source") || ""}
              onChange={(e) => change("source", e.target.value)}
              className="min-h-11 w-full sm:w-56"
            >
              <option value="">全部来源</option>
              {sources.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
            <Select
              aria-label="筛选分类"
              value={params.get("category") || ""}
              onChange={(e) => change("category", e.target.value)}
              className="min-h-11 w-full sm:w-36"
            >
              <option value="">全部分类</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
            <Select
              aria-label="处理状态"
              value={params.get("status") || ""}
              onChange={(e) => change("status", e.target.value)}
              className="min-h-11 w-full sm:w-36"
            >
              <option value="">全部状态</option>
              <option value="done">概括完成</option>
              <option value="queued">等待处理</option>
              <option value="error">需要重试</option>
              <option value="missing">尚无正文</option>
            </Select>
            <Input
              aria-label="文章起始日期"
              type="date"
              className="min-h-11 w-full sm:w-40"
              value={params.get("after") || ""}
              onChange={(e) => change("after", e.target.value)}
            />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={params.get("unread") === "true"}
                onChange={(e) =>
                  change("unread", e.target.checked ? "true" : "")
                }
              />
              未读
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={params.get("saved") === "true"}
                onChange={(e) =>
                  change("saved", e.target.checked ? "true" : "")
                }
              />
              收藏
            </label>
          </div>
          {status.data && (
            <p className="text-xs text-muted-foreground">
              {status.data.counts
                .map(
                  (c) =>
                    `${({ done: "已概括", queued: "等待处理", fetching: "获取正文", summarizing: "生成概括", error: "等待重试", missing: "尚无正文" } as Record<string, string>)[c.status] || c.status} ${c.n}`,
                )
                .join(" · ")}
            </p>
          )}
          {articles.isLoading ? (
            <div className="flex items-center gap-2 py-12">
              <Spinner />
              正在获取文章…
            </div>
          ) : articles.error ? (
            <p role="alert" className="text-danger">
              {articles.error.message}
            </p>
          ) : !articles.data?.articles.length ? (
            <div className="rounded-lg border border-dashed py-14 text-center">
              <h2 className="font-semibold">这里还没有文章</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                关注来源后，文章会出现在这里。也可以调整筛选条件。
              </p>
              <Button
                className="mt-5"
                variant="outline"
                onClick={() => setParams({ view: "sources" })}
              >
                管理来源
              </Button>
            </div>
          ) : (
            <div className="divide-y rounded-lg border bg-card">
              {articles.data.articles.map((a) => (
                <article key={a.id} className="group px-4 py-5 sm:px-6">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{a.source_title}</span>
                    <time>{rssDate(a.published_at)}</time>
                    <span>
                      {Math.max(1, Math.ceil(a.word_count / 250))} 分钟
                    </span>
                    <span
                      className={
                        a.completeness === "partial" ? "text-warning" : ""
                      }
                    >
                      {completenessLabel(a.completeness)}
                    </span>
                    {a.edition && <span>{levelLabel(a.edition.level)}</span>}
                  </div>
                  <Link
                    className="block max-w-4xl text-lg font-semibold leading-snug hover:text-primary"
                    to={`/rss/articles/${a.id}`}
                  >
                    {tab === "bulletin"
                      ? a.edition?.headline || a.title
                      : a.title}
                  </Link>
                  {a.edition ? (
                    <>
                      <p className="mt-2 max-w-4xl text-sm leading-relaxed text-muted-foreground">
                        {a.edition.intro}
                      </p>
                      {tab === "bulletin" && a.edition.points.length > 0 && (
                        <ul className="mt-3 max-w-4xl list-disc space-y-2 pl-5 text-sm leading-relaxed">
                          {a.edition.points.map((p, i) => (
                            <li key={i}>{p}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {a.status === "error"
                        ? a.error
                        : a.status === "missing"
                          ? "暂未获取到正文，可打开文章重试"
                          : "正文和概括正在准备中"}
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={a.saved ? "取消收藏" : "收藏文章"}
                      onClick={() =>
                        void action(async () => {
                          await rssApi(
                            `/articles/${a.id}`,
                            { saved: !a.saved },
                            "PATCH",
                          );
                        })
                      }
                    >
                      <Bookmark
                        size={14}
                        className={a.saved ? "fill-current" : ""}
                      />
                      {a.saved ? "已收藏" : "收藏"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void action(async () => {
                          await rssApi(
                            `/articles/${a.id}`,
                            { read: !a.read_at },
                            "PATCH",
                          );
                        })
                      }
                    >
                      <Check size={14} />
                      {a.read_at ? "标为未读" : "标为已读"}
                    </Button>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                    >
                      原文
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              disabled={!Number(params.get("page") || 0)}
              onClick={() =>
                change("page", String(Number(params.get("page") || 0) - 1))
              }
            >
              <ArrowLeft size={14} />
              上一页
            </Button>
            <Button
              variant="outline"
              disabled={!articles.data?.has_more}
              onClick={() =>
                change("page", String(Number(params.get("page") || 0) + 1))
              }
            >
              下一页
              <ArrowRight size={14} />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
