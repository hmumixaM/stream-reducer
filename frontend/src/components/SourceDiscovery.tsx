import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Link2, Plus, Radio, Search } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Input, Select, Spinner } from "@/components/ui";
import { EmptyState, ErrorState, InfiniteScrollSentinel, SectionHeader, Toolbar } from "@/components/shell";
import { followSource, searchSources, type SourcePlatform, type SourceProvider, type SourceSearchResult } from "@/lib/api";
import { useMe } from "@/lib/auth";

const LABELS: Record<string, string> = {
  youtube: "YouTube", bilibili: "B 站", apple_podcast: "Apple Podcasts", xiaoyuzhou: "小宇宙",
  folo: "Folo", rss: "RSS / 播客", article: "文章 / RSS",
};
export function discoveryProviders(platform: string): SourceProvider[] {
  if (platform === "xiaoyuzhou" || platform === "article" || platform === "rss") return ["folo"];
  if (platform) return [platform as SourceProvider, "folo"];
  return ["youtube", "bilibili", "apple_podcast", "folo"];
}

export function SourceDiscovery({ onAdd }: { onAdd: () => void }) {
  const me = useMe();
  const canFollow = Boolean(me.data?.user);
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "";
  const requestedPlatform = params.get("platform") || "";
  const platform = Object.keys(LABELS).includes(requestedPlatform) && requestedPlatform !== "folo" ? requestedPlatform : "";
  const [composing, setComposing] = useState(false);
  const [debounced, setDebounced] = useState(query.trim());
  useEffect(() => {
    if (composing) return;
    const timer = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query, composing]);
  const waiting = composing || query.trim() !== debounced;
  const queryKey = ["source-search", me.data?.user?.id ?? "anonymous", debounced, platform];
  const identity = JSON.stringify([me.data?.user?.id, query.trim(), platform, composing]);
  const arrivals = useRef<{ identity: string; providers: SourceProvider[] }>({ identity, providers: [] });
  if (arrivals.current.identity !== identity) arrivals.current = { identity, providers: [] };
  const known = useInfiniteQuery({
    queryKey: [...queryKey, "known"], enabled: !waiting,
    queryFn: ({ pageParam, signal }) => searchSources({ provider: "known", q: debounced, platform, offset: pageParam }, signal),
    initialPageParam: 0, getNextPageParam: last => last.next_offset ?? undefined,
    retry: false, refetchOnWindowFocus: false,
  });
  const providers = discoveryProviders(platform);
  const external = useQueries({ queries: providers.map(provider => ({
    queryKey: [...queryKey, provider], enabled: canFollow && !waiting && Boolean(debounced),
    queryFn: ({ signal }: { signal: AbortSignal }) => searchSources({ provider, q: debounced, platform }, signal),
    retry: false, refetchOnWindowFocus: false, staleTime: 10 * 60 * 1000,
  })) });
  external.map((query, i) => ({ query, provider: providers[i] })).filter(r => r.query.data)
    .sort((a, b) => a.query.dataUpdatedAt - b.query.dataUpdatedAt).forEach(({ provider }) => {
      if (!arrivals.current.providers.includes(provider)) arrivals.current.providers.push(provider);
    });
  const update = (key: string, value: string) => {
    void client.cancelQueries({ queryKey: ["source-search"] });
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: key === "q" });
  };
  const [followed, setFollowed] = useState<SourceSearchResult[]>([]);
  useEffect(() => setFollowed([]), [me.data?.user?.id]);
  const syncFollow = (row: SourceSearchResult) => {
    setFollowed(prev => [...prev.filter(r => r.key !== row.key), row]);
    // Keep current rows in place. Subsequent visits can refresh their ordering.
    void client.invalidateQueries({ queryKey: ["source-search"], refetchType: "none" });
    for (const queryKey of [["channels"], ["rss"], ["subs"], ["bulletin", "feed"], ["timeline"]]) {
      void client.invalidateQueries({ queryKey });
    }
  };
  const mergeFollow = (row: SourceSearchResult) => {
    const next = followed.find(f => f.aliases.some(a => row.aliases.includes(a)));
    return next ? { ...row, following: true, platform: next.platform, kind: next.kind, channel_id: next.channel_id, rss_source_id: next.rss_source_id } : row;
  };
  const knownRows = waiting ? [] : (known.data?.pages.flatMap(p => p.results) || []);
  const seen = new Set(knownRows.flatMap(r => r.aliases));
  const remoteRows: SourceSearchResult[] = [];
  if (!waiting && !known.isPending) {
    for (const provider of arrivals.current.providers) {
      const data = external[providers.indexOf(provider)]?.data;
      for (const row of data?.results || []) {
        if (row.aliases.some(a => seen.has(a))) continue;
        row.aliases.forEach(a => seen.add(a));
        remoteRows.push(row);
      }
    }
  }
  const searching = waiting || known.isFetching || (canFollow && Boolean(debounced) && external.some(q => q.isPending || q.isFetching));
  const failed = known.isError || external.some(q => q.isError);
  const renderRows = (rows: SourceSearchResult[]) => <ul className="divide-y divide-border rounded-xl border border-border bg-card">
    {rows.map(row => <SourceResultRow key={row.key} source={mergeFollow(row)} query={debounced} canFollow={canFollow} onFollow={syncFollow} />)}
  </ul>;

  return <div className="space-y-6">
    <Toolbar className="mb-0">
      <label className="relative min-w-0 flex-1 basis-64">
        <span className="sr-only">搜索来源</span>
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={query} maxLength={100} placeholder="搜索频道、播客或文章源" className="pl-9" name="q"
          onChange={e => update("q", e.target.value)} onCompositionStart={() => setComposing(true)}
          onCompositionEnd={e => { setComposing(false); update("q", e.currentTarget.value); }} />
      </label>
      <Select aria-label="来源平台" value={platform} className="w-auto min-w-0" onChange={e => update("platform", e.target.value)}>
        <option value="">全部平台</option>
        {(["youtube", "bilibili", "apple_podcast", "xiaoyuzhou", "article"] as SourcePlatform[]).map(p => <option key={p} value={p}>{LABELS[p]}</option>)}
      </Select>
      {canFollow ? <Button variant="outline" onClick={onAdd}><Link2 className="h-4 w-4" />通过链接添加</Button>
        : <Link to="/login"><Button variant="outline">登录后关注</Button></Link>}
    </Toolbar>
    {platform === "xiaoyuzhou" && <p className="text-sm text-muted-foreground">搜索 Folo 已收录的小宇宙节目，目录不覆盖全部节目。</p>}
    <section aria-labelledby="known-sources-title">
      <SectionHeader id="known-sources-title" title="已知来源" subtitle="reducer 已收录的频道、播客和文章源" />
      {(waiting || known.isPending) && <p className="flex items-center gap-2 py-5 text-sm text-muted-foreground" role="status"><Spinner />正在查找已知来源…</p>}
      {!waiting && known.isError && <ErrorState message="已知来源加载失败" onRetry={() => known.refetch()} />}
      {knownRows.length > 0 && renderRows(knownRows)}
      {!waiting && known.hasNextPage && <InfiniteScrollSentinel hasNextPage isFetchingNextPage={known.isFetchingNextPage}
        fetchNextPage={() => known.fetchNextPage()} variant="rows" error={known.isFetchNextPageError ? known.error : undefined} />}
      {!waiting && !known.isPending && !known.isError && knownRows.length === 0 && <p className="py-4 text-sm text-muted-foreground">{debounced ? "没有匹配的已知来源" : "还没有已知来源，可以通过链接添加。"}</p>}
    </section>
    {query.trim() && canFollow && <section aria-labelledby="external-sources-title">
      <SectionHeader id="external-sources-title" title="外部来源" subtitle="结果会陆续显示，可直接关注到 reducer" />
      <div className="mb-4 flex flex-wrap gap-2" aria-live="polite">
        {providers.map((provider, i) => {
          const result = external[i];
          return <div key={provider} className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs">
            {waiting || result.isPending || result.isFetching ? <Spinner /> : result.isError ? null : <Check className="h-3 w-3" />}
            <span>{LABELS[provider]}{result.isError && !waiting ? " 暂时不可用" : ""}</span>
            {result.isError && !waiting && <button className="ml-1 text-primary underline" onClick={() => result.refetch()}>重试</button>}
          </div>;
        })}
      </div>
      {remoteRows.length > 0 && renderRows(remoteRows)}
      {external.some(q => q.isError) && <p className="mt-3 text-sm text-muted-foreground">部分平台搜索失败，可重试或通过链接添加。{external[providers.indexOf("folo")]?.isError ? " Folo 连接可能需要更新。" : ""}</p>}
    </section>}
    {query.trim() && !canFollow && <p className="text-sm text-muted-foreground"><Link to="/login" className="text-primary underline">登录</Link>后可同时搜索 YouTube、B 站、播客和 Folo 公开目录。</p>}
    {!searching && !failed && debounced && knownRows.length === 0 && remoteRows.length === 0 && <EmptyState title="没有找到匹配来源" description="试试其他名称，或通过链接添加来源。" />}
  </div>;
}

function SourceResultRow({ source, query, canFollow, onFollow }: {
  source: SourceSearchResult; query: string; canFollow: boolean; onFollow: (row: SourceSearchResult) => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const mutation = useMutation({ mutationFn: () => followSource(source, query), onSuccess: onFollow });
  const title = source.channel_id ? `/channels/${source.channel_id}` : null;
  return <li className="flex min-w-0 items-start gap-3 p-4">
    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
      {source.image_url && !imageFailed ? <img src={source.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setImageFailed(true)} /> : <Radio className="h-5 w-5" />}
    </div>
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground"><span>{LABELS[source.platform]}</span>{source.provider === "folo" && <span>通过 Folo 发现</span>}</div>
      {title ? <Link className="line-clamp-2 font-semibold hover:text-primary" to={title}>{source.title}</Link>
        : <a className="line-clamp-2 font-semibold hover:text-primary" href={source.url} target="_blank" rel="noreferrer">{source.title}</a>}
      {source.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{source.description}</p>}
      <a className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-primary" href={source.url} target="_blank" rel="noreferrer"><span className="truncate">查看来源</span><ExternalLink className="h-3 w-3 shrink-0" /></a>
      {mutation.isError && <p className="mt-2 text-sm text-danger" role="alert">关注未完成，请重试或通过链接添加。</p>}
    </div>
    {canFollow ? <Button size="sm" variant={source.following ? "outline" : "default"} className="shrink-0" disabled={source.following || mutation.isPending} aria-busy={mutation.isPending} onClick={() => mutation.mutate()}>
      {mutation.isPending ? <Spinner /> : source.following ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
      {mutation.isPending ? "关注中" : source.following ? "已关注" : mutation.isError ? "重试" : "关注"}
    </Button> : <Link className="shrink-0 text-sm text-primary" to="/login">登录关注</Link>}
  </li>;
}
