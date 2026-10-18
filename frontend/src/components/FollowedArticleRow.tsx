import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Rss } from "lucide-react";
import { Button, Card, Spinner } from "@/components/ui";
import { rssApi, type RssSource } from "@/lib/rss";
import { timeAgo } from "@/lib/utils";

export const articleSourceHasError = (source: RssSource) => Boolean(source.last_error || source.auth_error || source.connection_status === "needs_auth" || source.connection_enabled === 0);

export function FollowedArticleRow({ source, paused }: { source: RssSource; paused: boolean }) {
  const client = useQueryClient();
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const invalidate = () => {
    for (const queryKey of [["rss"], ["source-search"], ["bulletin", "feed"]]) void client.invalidateQueries({ queryKey });
  };
  const refresh = useMutation({
    mutationFn: () => rssApi(`/sources/${source.id}/refresh`, {}),
    onSuccess: () => { setQueuedAt(source.poll_count); invalidate(); },
  });
  const unfollow = useMutation({ mutationFn: () => rssApi(`/sources/${source.id}`, {}, "DELETE"), onSuccess: invalidate });
  const blocked = source.connection_status === "needs_auth" || source.connection_enabled === 0 || Boolean(source.auth_error);
  const running = Boolean(source.lease_until && Date.parse(source.lease_until) > Date.now());
  const queued = queuedAt !== null && source.poll_count <= queuedAt;
  const pollState = paused ? "自动更新已暂停" : blocked ? "连接需要恢复" : running ? "正在检查更新" : queued || !source.last_checked_at ? "等待检查更新" : source.last_error ? "检查失败，稍后重试" : "自动更新中";
  return <Card className="p-3">
    <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
        {source.image_url && !imageFailed ? <img src={source.image_url} alt="" className="h-full w-full object-contain" onError={() => setImageFailed(true)} /> : <Rss size={18} />}
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link className="break-words font-medium hover:text-primary" to={`/bulletin?platform=article&source=${source.id}`}>{source.title}</Link>
          <span className="text-xs text-muted-foreground">{source.provider === "substack" ? "Substack" : "RSS / 文章"}</span>
          <span className="text-xs text-muted-foreground" role="status">{pollState}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{source.article_count} 篇文章 · 约每 30 分钟检查 · {source.last_checked_at ? `最近检查 ${timeAgo(source.last_checked_at)}` : "尚未完成首次检查"}</p>
        {!paused && !blocked && source.next_poll_at && <p className="mt-1 text-xs text-muted-foreground">{Date.parse(source.next_poll_at) <= Date.now() ? "已到更新时间，等待调度" : `下次检查 ${new Date(source.next_poll_at).toLocaleString()}`}</p>}
        {source.latest_published_at && <p className="mt-1 text-xs text-muted-foreground">最新文章 {timeAgo(source.latest_published_at)}</p>}
        {source.backfill_status === "gap" && <p className="mt-1 text-xs text-muted-foreground">历史文章可能不全；新文章仍会继续自动检查。</p>}
        {(source.last_error || blocked) && <p className="mt-1 break-words text-xs text-warning">{source.last_error || "Substack 连接不可用，请管理员检查连接。"}</p>}
        {(refresh.error || unfollow.error) && <p className="mt-1 text-xs text-danger" role="alert">{(refresh.error || unfollow.error)?.message}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <a className="p-2 text-muted-foreground" href={source.site_url || source.url} target="_blank" rel="noreferrer" aria-label={`打开 ${source.title} 网站`}><ExternalLink size={14} /></a>
        <Button size="sm" variant="outline" disabled={paused || blocked || refresh.isPending || running || queued} onClick={() => refresh.mutate()}>
          {refresh.isPending || running ? <Spinner /> : <RefreshCw size={14} />}检查更新
        </Button>
        <Button size="sm" variant="ghost" disabled={unfollow.isPending} onClick={() => unfollow.mutate()}>取消关注</Button>
      </div>
    </div>
  </Card>;
}
