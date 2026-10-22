import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Newspaper,
  RefreshCw,
  Search,
  Settings2,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type BulletinCardItem } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { dateLabel } from "@/lib/bulletin";
import {
  supportsInfiniteScroll,
  useInfiniteScroll,
} from "@/lib/useInfiniteScroll";
import { cn } from "@/lib/utils";
import { Button, Input, Select } from "@/components/ui";
import { BulletinCard } from "@/components/BulletinCard";
import { EmptyState, ErrorState, PageHeader } from "@/components/shell";

export function Bulletin() {
  const me = useMe();
  const zh = me.data?.user?.preferred_language === "zh";
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const platform = params.get("platform") || "";
  const source = params.get("source") || "";
  const saved = params.get("saved") === "true";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) return;
    const timer = window.setTimeout(() => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (search.trim()) next.set("q", search.trim());
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, q, setParams]);
  const setFilter = (name: string, value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );
  const feed = useInfiniteQuery({
    queryKey: [
      "bulletin",
      "feed",
      me.data?.user?.id,
      zh,
      q,
      platform,
      saved,
      source,
    ],
    queryFn: ({ pageParam }) =>
      api.listBulletins({ cursor: pageParam, q, platform, saved, source }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: 60_000,
  });
  const loadMoreRef = useInfiniteScroll({
    hasNextPage: Boolean(feed.hasNextPage),
    isFetchingNextPage: feed.isFetchingNextPage,
    fetchNextPage: () => feed.fetchNextPage({ cancelRefetch: false }),
    disabled: feed.isFetching || feed.isError,
  });
  const items = useMemo(
    () => [
      ...new Map(
        (feed.data?.pages.flatMap((page) => page.items) || []).map((item) => [
          `${item.content_type || "media"}:${item.id}`,
          item,
        ]),
      ).values(),
    ],
    [feed.data],
  );
  const groups = useMemo(() => {
    const result = new Map<string, BulletinCardItem[]>();
    for (const item of items) {
      const label = dateLabel(item.published_at || item.created_at, zh);
      result.set(label, [...(result.get(label) || []), item]);
    }
    return [...result];
  }, [items, zh]);

  return (
    <div className="bulletin-desk mx-auto max-w-5xl pb-14">
      <PageHeader title={zh ? "简报" : "Bulletin"} subtitle={zh ? "来自你关注和收藏的来源。先读重点，再深入了解。" : "The key ideas from the sources you follow and save. Read at your own depth."} actions={<>
        <Link to="/subscriptions?tab=articles" className="reader-control">{zh ? "关注来源" : "Follow sources"}</Link>
        <Link to="/preferences" className="reader-control"><Settings2 size={15} />{zh ? "阅读偏好" : "Reading preferences"}</Link>
      </>} />

      <div className="desk-toolbar">
        <div
          className="flex gap-1"
          aria-label={zh ? "内容范围" : "Content scope"}
        >
          <button
            className={cn("desk-tab", !saved && "is-active")}
            onClick={() => setFilter("saved", "")}
          >
            {zh ? "全部简报" : "All bulletins"}
          </button>
          <button
            className={cn("desk-tab", saved && "is-active")}
            onClick={() => setFilter("saved", "true")}
          >
            {zh ? "知识库" : "My library"}
          </button>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <div className="relative min-w-[150px] flex-1 sm:max-w-[240px]">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={zh ? "搜索标题或来源" : "Search title or source"}
              aria-label={zh ? "搜索简报" : "Search bulletins"}
              className="bg-transparent pl-9"
            />
          </div>
          <Select
            value={platform}
            onChange={(event) => setFilter("platform", event.target.value)}
            aria-label={zh ? "平台" : "Platform"}
            className="w-auto max-w-[145px] bg-transparent"
          >
            <option value="">{zh ? "所有平台" : "All platforms"}</option>
            <option value="youtube">YouTube</option>
            <option value="bilibili">Bilibili</option>
            <option value="xiaoyuzhou">小宇宙</option>
            <option value="apple_podcast">Apple Podcasts</option>
            <option value="rss">RSS / Podcast</option>
            <option value="article">
              {zh ? "文章 / Folo" : "Articles / Folo"}
            </option>
          </Select>
          <button
            className="desk-icon-button"
            onClick={() => feed.refetch()}
            disabled={feed.isFetching}
            aria-label={zh ? "刷新简报" : "Refresh bulletins"}
          >
            <RefreshCw
              size={15}
              className={feed.isFetching ? "animate-spin" : ""}
            />
          </button>
        </div>
      </div>
      {source && (
        <p className="mt-4 text-sm text-muted-foreground">
          {zh
            ? "正在查看所选文章来源。"
            : "Showing the selected article source."}
          <button
            className="ml-3 min-h-11 text-primary hover:underline"
            onClick={() => setFilter("source", "")}
          >
            {zh ? "查看全部来源" : "All sources"}
          </button>
        </p>
      )}
      {feed.isLoading ? (
        <div
          aria-label={zh ? "加载简报" : "Loading bulletins"}
          className="space-y-5 py-6"
        >
          {[0, 1, 2].map((key) => (
            <div
              key={key}
              className="h-56 animate-pulse rounded-xl bg-muted/40"
            />
          ))}
        </div>
      ) : feed.isError && !items.length ? (
        <ErrorState
          message={
            zh ? "简报加载失败，请重试。" : "Bulletins could not be loaded."
          }
          onRetry={() => feed.refetch()}
        />
      ) : !items.length ? (
        <EmptyState
          icon={<Newspaper size={22} />}
          title={
            q || platform || saved
              ? zh
                ? "没有匹配的简报"
                : "No matching bulletins"
              : zh
                ? "第一份简报，从关注一个来源开始"
                : "Your first bulletin starts with a source"
          }
          description={
            zh
              ? "关注视频、播客或文章来源，处理完成后会出现在这里。"
              : "Follow video, podcast or article sources. New summaries appear here automatically."
          }
          action={
            <Link to="/subscriptions">
              <Button variant="outline">
                {zh ? "浏览来源" : "Explore sources"}
                <ArrowUpRight size={14} />
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="pt-3">
          {groups.map(([date, entries]) => (
            <section key={date} className="desk-day">
              <div className="desk-day-label">
                <span>{date}</span>
                <span className="text-muted-foreground/60">
                  {entries.length} {zh ? "篇" : "stories"}
                </span>
              </div>
              <div className="desk-timeline">
                {entries.map((item) => (
                  <BulletinCard
                    key={`${item.content_type || "media"}:${item.id}`}
                    item={item}
                    zh={zh}
                  />
                ))}
              </div>
            </section>
          ))}
          {feed.isError && (
            <ErrorState
              compact
              message={
                zh
                  ? "未能加载更多内容，已加载的简报仍可阅读。"
                  : "More bulletins could not be loaded. Your current stories are still available."
              }
              onRetry={() =>
                feed.isFetchNextPageError
                  ? feed.fetchNextPage({ cancelRefetch: false })
                  : feed.refetch()
              }
            />
          )}
          {feed.hasNextPage ? (
            <div
              ref={loadMoreRef}
              className="mt-8 flex min-h-12 items-center justify-center"
              role="status"
              aria-live="polite"
            >
              {!feed.isError &&
                (feed.isFetchingNextPage ? (
                  <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <RefreshCw size={14} className="animate-spin" />
                    {zh ? "正在加载更早的简报…" : "Loading earlier bulletins…"}
                  </p>
                ) : !supportsInfiniteScroll ? (
                  <Button
                    variant="outline"
                    onClick={() => feed.fetchNextPage({ cancelRefetch: false })}
                    disabled={feed.isFetching}
                  >
                    <ArrowDown size={14} />
                    {zh ? "更早的简报" : "Earlier bulletins"}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {zh
                      ? "继续向下滚动，加载更早的简报"
                      : "Scroll to load earlier bulletins"}
                  </p>
                ))}
            </div>
          ) : (
            !feed.isError && (
              <p className="desk-end">
                <Check size={14} />
                {zh ? "已读到这份信息流的起点" : "You’ve reached the beginning"}
              </p>
            )
          )}
        </div>
      )}
    </div>
  );
}
