import { useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ExternalLink,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { useMe } from "@/lib/auth";
import {
  rssApi,
  type RssSource,
  type RssPreview,
  type RssStatus,
} from "@/lib/rss";
import { cn, timeAgo } from "@/lib/utils";

interface PublicSource {
  id: number;
  title: string;
  url: string;
  feed_url: string | null;
  image_url: string | null;
  site_url: string | null;
  following: number;
  article_count: number;
  latest_published_at: string | null;
}
function SourceAvatar({ source }: { source: PublicSource | RssSource }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-lg font-semibold text-muted-foreground">
      {source.image_url && !failed ? (
        <img
          src={source.image_url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain p-1"
          onError={() => setFailed(true)}
        />
      ) : (
        source.title.slice(0, 1)
      )}
    </div>
  );
}

// Legacy RSS links retain their destination while reading moves into Bulletin.
export function Rss() {
  const [params] = useSearchParams();
  if (params.get("view") === "sources")
    return <Navigate replace to="/subscriptions?tab=articles" />;
  const next = new URLSearchParams({ platform: "article" });
  if (params.get("source")) next.set("source", params.get("source")!);
  if (params.get("saved") === "true") next.set("saved", "true");
  return <Navigate replace to={`/bulletin?${next}`} />;
}

export function ArticleSources() {
  const me = useMe();
  const [params] = useSearchParams();
  const client = useQueryClient();
  const [view, setView] = useState<"discover" | "following">("discover");
  const [search, setSearch] = useState("");
  const [choices, setChoices] = useState<{ url: string; title: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [preview, setPreview] = useState<RssPreview | null>(null);
  const [opml, setOpml] = useState<string | null>(null);
  const enabled = !!me.data?.user;
  const catalog = useQuery({
    queryKey: ["rss", "catalog", me.data?.user?.id],
    queryFn: () => rssApi<PublicSource[]>("/catalog"),
    enabled,
    refetchInterval: 30000,
  });
  const follows = useQuery({
    queryKey: ["rss", "sources", me.data?.user?.id],
    queryFn: () => rssApi<RssSource[]>("/sources"),
    enabled,
    refetchInterval: 30000,
  });
  const status = useQuery({
    queryKey: ["rss", "status", me.data?.user?.id],
    queryFn: () => rssApi<RssStatus>("/status"),
    enabled,
  });
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
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
  if (!enabled)
    return (
      <p className="py-10 text-center text-muted-foreground">
        <Link className="text-primary underline" to="/login">
          登录
        </Link>
        后发现和关注文章来源，文章会持续出现在 Bulletin。
      </p>
    );
  const focus = Number(params.get("source"));
  const rows = (catalog.data || []).filter(
    (s) =>
      (view !== "following" || s.following) &&
      (!focus || s.id === focus) &&
      `${s.title} ${s.feed_url || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" aria-label="文章来源范围">
          <button
            className={cn("desk-tab", view === "discover" && "is-active")}
            onClick={() => setView("discover")}
          >
            发现来源
          </button>
          <button
            className={cn("desk-tab", view === "following" && "is-active")}
            onClick={() => setView("following")}
          >
            已关注 {follows.data?.length || 0}
          </button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="relative min-w-0">
            <Search size={15} className="absolute left-3 top-3" />
            <Input
              aria-label="搜索文章来源"
              placeholder="搜索文章来源"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 sm:w-56"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => setAdding(!adding)}
            aria-expanded={adding}
          >
            <Plus size={15} />
            添加来源
          </Button>
        </div>
      </div>
      <p className="text-sm leading-7 text-muted-foreground">
        关注公开文章来源后，新文章会自动获取并概括，与视频、播客一起出现在{" "}
        <Link to="/bulletin" className="text-primary underline">
          Bulletin
        </Link>
        。无需在 Folo 创建订阅。
      </p>
      {focus > 0 && (
        <Link
          to="/subscriptions?tab=articles"
          className="inline-block text-sm text-primary"
        >
          查看全部文章来源
        </Link>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      {adding && (
        <Card className="space-y-4 p-4 sm:p-6">
          <h2 className="font-semibold">添加文章来源</h2>
          <p className="text-sm text-muted-foreground">
            粘贴 RSS / Atom、RSSHub 或 Folo 来源链接。
          </p>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const resolved = await rssApi<{
                  choices?: { url: string; title: string }[];
                }>("/resolve", { url });
                if (resolved.choices) {
                  setChoices(resolved.choices);
                  return;
                }
                setChoices([]);
                await rssApi("/sources", { url });
                setUrl("");
                setNotice("已关注，新文章会出现在 Bulletin。");
              });
            }}
          >
            <Input
              required
              aria-label="来源或 RSS 链接"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button disabled={busy || !url.trim()} type="submit">
              关注来源
            </Button>
          </form>
          {choices.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm">此网站有多个 RSS 来源，请选择后关注：</p>
              {choices.map((choice) => (
                <Button
                  key={choice.url}
                  variant="outline"
                  className="h-auto min-h-11 max-w-full whitespace-normal break-all"
                  onClick={() => {
                    setUrl(choice.url);
                    setChoices([]);
                  }}
                >
                  {choice.title}
                </Button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
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
            <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border px-4 text-sm focus-within:ring-2">
              导入 OPML
              <input
                type="file"
                accept=".opml,.xml,text/xml"
                aria-label="导入 OPML 文件"
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
          </div>
          {preview && (
            <div className="space-y-3 border-t pt-4">
              <p className="text-sm">
                将关注 {preview.sources.length} 个公开文章来源，跳过{" "}
                {preview.skipped} 个不适用来源。
              </p>
              <div className="flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const result = await rssApi<{ imported: number }>(
                        opml ? "/import/opml" : "/import/folo",
                        opml
                          ? { text: opml, execute: true }
                          : { execute: true },
                      );
                      setPreview(null);
                      setNotice(`已关注 ${result.imported} 个来源。`);
                    })
                  }
                >
                  确认导入
                </Button>
                <Button variant="ghost" onClick={() => setPreview(null)}>
                  取消
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
      {catalog.isLoading ? (
        <Spinner />
      ) : catalog.error ? (
        <p role="alert">{catalog.error.message}</p>
      ) : !rows.length ? (
        <p className="py-12 text-center text-muted-foreground">
          {view === "following"
            ? "还没有关注文章来源。切换到发现来源，选择你感兴趣的网站。"
            : "没有匹配的来源，可以添加 RSS 或 Folo 链接。"}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((s) => {
            const follow = follows.data?.find((f) => f.id === s.id);
            return (
              <Card key={s.id} className="flex h-full flex-col gap-3 p-4">
                <div className="flex gap-3">
                  <SourceAvatar source={s} />
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 text-xs text-muted-foreground">
                      文章来源
                    </p>
                    <Link
                      to={`/bulletin?platform=article&source=${s.id}`}
                      className="line-clamp-2 font-semibold leading-snug hover:text-primary hover:underline"
                    >
                      {s.title}
                    </Link>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {s.article_count} 篇文章
                  {s.latest_published_at
                    ? ` · 最近发布 ${timeAgo(s.latest_published_at)}`
                    : ""}
                </p>
                <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-1">
                  <a
                    href={s.site_url || s.feed_url || s.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`打开 ${s.title} 网站`}
                    className="mr-auto inline-flex min-h-11 items-center text-muted-foreground"
                  >
                    <ExternalLink size={14} />
                  </a>
                  {s.following ? (
                    <>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await rssApi(`/sources/${s.id}`, {}, "DELETE");
                          })
                        }
                      >
                        <Check size={14} />
                        已关注
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${s.title} 来源设置`}
                        onClick={() =>
                          setExpanded(expanded === s.id ? null : s.id)
                        }
                      >
                        <MoreHorizontal size={16} />
                      </Button>
                    </>
                  ) : (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await rssApi(`/sources/${s.id}/follow`, {});
                          setNotice(`已关注 ${s.title}，文章已加入 Bulletin。`);
                        })
                      }
                    >
                      <Plus size={14} />
                      关注
                    </Button>
                  )}
                </div>
                {expanded === s.id && follow && (
                  <div className="space-y-3 border-t pt-3 text-xs text-muted-foreground">
                    <p>
                      约每 30 分钟更新
                      {follow.last_checked_at
                        ? ` · 最近检查 ${timeAgo(follow.last_checked_at)}`
                        : ""}
                    </p>
                    {follow.last_error && (
                      <p className="text-warning">{follow.last_error}</p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await rssApi(`/sources/${s.id}/refresh`, {});
                          setNotice("已安排检查更新。");
                        })
                      }
                    >
                      <RefreshCw size={13} />
                      检查更新
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
