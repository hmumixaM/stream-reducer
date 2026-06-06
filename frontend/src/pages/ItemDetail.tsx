import { useState, useEffect, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import {
  ArrowLeft,
  RefreshCw,
  Trash2,
  ExternalLink,
  ChevronDown,
  Star,
  Archive,
  ArchiveRestore,
  MessageSquare,
  Send,
  BookOpen,
} from "lucide-react";
import { api, type StageRun, type Comment } from "@/lib/api";
import { MIRROR } from "@/lib/mirror";
import { Button, Card, Spinner } from "@/components/ui";
import { PlatformBadge, StatusBadge } from "@/components/badges";
import {
  formatBytes,
  formatCost,
  formatCount,
  formatDate,
  formatDuration,
  formatMs,
  timeAgo,
  cn,
} from "@/lib/utils";

export function ItemDetail() {
  const { id } = useParams();
  const itemId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showTranscript, setShowTranscript] = useState(false);
  const [showComments, setShowComments] = useState(false);
  
  const [readMode, setReadMode] = useState(() => {
    return localStorage.getItem("sr_read_mode") === "true";
  });

  useEffect(() => {
    localStorage.setItem("sr_read_mode", String(readMode));
  }, [readMode]);

  const item = useQuery({
    queryKey: ["item", itemId],
    queryFn: () => api.getItem(itemId),
    refetchInterval: (q) =>
      q.state.data && ["done", "error"].includes(q.state.data.status) ? false : 3000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["item", itemId] });
    qc.invalidateQueries({ queryKey: ["items"] });
  };
  const regenerate = useMutation({
    mutationFn: () => api.regenerateItem(itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["item", itemId] }),
  });
  const favorite = useMutation({
    mutationFn: () => api.toggleFavorite(itemId),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: () => api.toggleArchive(itemId),
    onSuccess: invalidate,
  });
  const retry = useMutation({
    mutationFn: () => api.retryItem(itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["item", itemId] }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteItem(itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      navigate("/");
    },
  });
  const deleteMedia = useMutation({
    mutationFn: () => api.deleteMedia(itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["item", itemId] }),
  });

  if (item.isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (item.isError || !item.data)
    return <p className="text-red-400">Failed to load item.</p>;

  const d = item.data;

  return (
    <div className={readMode ? "mx-auto max-w-3xl" : ""}>
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Library
      </Link>

      <div className="mb-4 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex-1">
          <div className="mb-2 flex items-center gap-2">
            <PlatformBadge platform={d.platform} />
            <StatusBadge status={d.status} />
          </div>
          <h1 className="text-2xl font-semibold leading-tight">{d.title || d.source_url}</h1>
          {d.author && <p className="mt-1 text-sm text-muted-foreground">{d.author}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!readMode && !MIRROR && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => favorite.mutate()}
                disabled={favorite.isPending}
                title={d.is_favorite ? "Unfavorite" : "Favorite"}
              >
                <Star
                  className={`h-4 w-4 ${d.is_favorite ? "fill-amber-400 text-amber-400" : ""}`}
                />
                <span className="hidden sm:inline">{d.is_favorite ? "Favorited" : "Favorite"}</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => archive.mutate()}
                disabled={archive.isPending}
                title={d.is_archived ? "Unarchive" : "Archive"}
              >
                {d.is_archived ? (
                  <ArchiveRestore className="h-4 w-4" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">{d.is_archived ? "Archived" : "Archive"}</span>
              </Button>
            </>
          )}
          <a href={d.source_url} target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm">
              <ExternalLink className="h-4 w-4" /> <span className="hidden sm:inline">Source</span>
            </Button>
          </a>
          <Button 
            variant={readMode ? "default" : "outline"} 
            size="sm" 
            onClick={() => setReadMode(!readMode)}
            title={readMode ? "Exit read mode" : "Read mode"}
          >
            <BookOpen className="h-4 w-4" /> <span className="hidden sm:inline">{readMode ? "Exit read mode" : "Read mode"}</span>
          </Button>
          {!readMode && !MIRROR &&
            (d.status === "error" ? (
              <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
                <RefreshCw className="h-4 w-4" /> <span className="hidden sm:inline">Retry</span>
              </Button>
            ) : (
              (() => {
                const processing =
                  regenerate.isPending || !["done", "error"].includes(d.status);
                return (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => regenerate.mutate()}
                    disabled={processing}
                  >
                    <RefreshCw className={`h-4 w-4 ${processing ? "animate-spin" : ""}`} />
                    <span className="hidden sm:inline">{processing ? "Regenerating…" : "Regenerate"}</span>
                  </Button>
                );
              })()
            ))}
          {!readMode && !MIRROR && (
            <Button variant="danger" size="sm" onClick={() => remove.mutate()}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {d.error && (
        <Card className="mb-4 border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {d.error}
        </Card>
      )}

      <div className={readMode ? "block" : "grid grid-cols-1 gap-6 lg:grid-cols-3"}>
        <div className={readMode ? "" : "lg:col-span-2"}>
          {d.summary ? (
            <Card className={readMode ? "border-none shadow-none bg-transparent" : "p-6"}>
              <div className={readMode ? "prose-read max-w-none" : "prose-sr max-w-none text-sm"}>
                <ReactMarkdown>{d.summary.markdown}</ReactMarkdown>
              </div>
            </Card>
          ) : (
            <Card className="flex items-center gap-3 p-6 text-muted-foreground">
              {["done", "error"].includes(d.status) ? (
                "No summary available."
              ) : (
                <>
                  <Spinner /> Processing… the summary will appear here.
                </>
              )}
            </Card>
          )}

          {d.transcript && (
            <Card className={cn("mt-4 p-4", readMode && "border-dashed bg-transparent shadow-none")}>
              <button
                onClick={() => setShowTranscript((s) => !s)}
                className="flex w-full items-center justify-between text-sm font-medium"
              >
                <span>
                  Transcript{" "}
                  <span className="text-muted-foreground">
                    ({d.transcript.source}
                    {d.transcript.language ? `, ${d.transcript.language}` : ""})
                  </span>
                </span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${showTranscript ? "rotate-180" : ""}`}
                />
              </button>
              {showTranscript && (
                <div className="mt-3 max-h-96 space-y-1 overflow-auto text-sm text-muted-foreground">
                  {d.transcript.segments.map((seg, i) => (
                    <p key={i}>
                      <span className="mr-2 font-mono text-xs text-primary">
                        {formatTs(seg.start)}
                      </span>
                      {seg.text}
                    </p>
                  ))}
                </div>
              )}
            </Card>
          )}

          {!MIRROR && (
            readMode ? (
              <Card className="mt-4 p-4 border-dashed bg-transparent shadow-none">
                <button
                  onClick={() => setShowComments((s) => !s)}
                  className="flex w-full items-center justify-between text-sm font-medium"
                >
                  <span className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" /> Comments
                    {d.comments.length > 0 && (
                      <span className="text-muted-foreground">({d.comments.length})</span>
                    )}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${showComments ? "rotate-180" : ""}`}
                  />
                </button>
                {showComments && (
                  <div className="mt-4">
                    <CommentsSection itemId={itemId} comments={d.comments} />
                  </div>
                )}
              </Card>
            ) : (
              <CommentsSection itemId={itemId} comments={d.comments} />
            )
          )}
        </div>

        {!readMode && (
          <div className="space-y-4">
            <MediaPanel
              videoDuration={d.duration_s}
              audioDuration={d.audio_duration_s}
              mediaBytes={d.media_bytes}
              publishedAt={d.published_at}
              viewCount={d.view_count}
              likeCount={d.like_count}
              dislikeCount={d.dislike_count}
              transcriptEnd={
                d.transcript?.segments?.length
                  ? d.transcript.segments[d.transcript.segments.length - 1].end
                  : null
              }
              mediaPath={d.media_path}
              onDeleteMedia={() => deleteMedia.mutate()}
              deletingMedia={deleteMedia.isPending}
            />
            {!MIRROR && (
              <ProcessingPanel
                stages={d.stages}
                totalMs={d.total_processing_ms}
                totalCost={d.total_cost_usd}
                totalReq={d.total_api_requests}
                totalTokens={d.total_tokens}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProcessingPanel({
  stages,
  totalMs,
  totalCost,
  totalReq,
  totalTokens,
}: {
  stages: StageRun[];
  totalMs: number;
  totalCost: number;
  totalReq: number;
  totalTokens: number;
}) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold">Processing</h2>
      <div className="mb-4 grid grid-cols-2 gap-3 text-center">
        <Metric label="Total time" value={formatMs(totalMs)} />
        <Metric label="Cost" value={formatCost(totalCost)} />
        <Metric label="Requests" value={String(totalReq)} />
        <Metric label="Tokens" value={totalTokens.toLocaleString()} />
      </div>
      <div className="space-y-3">
        {stages.length === 0 && (
          <p className="text-xs text-muted-foreground">No stages yet.</p>
        )}
        {stages.map((s) => (
          <div key={s.id} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium capitalize">{s.stage}</span>
              <span
                className={`text-xs ${
                  s.status === "done"
                    ? "text-emerald-400"
                    : s.status === "error"
                      ? "text-red-400"
                      : "text-amber-400"
                }`}
              >
                {s.status === "running" ? `${s.chunk_done}/${s.chunk_count || "?"}` : s.status}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{formatMs(s.duration_ms)}</span>
              {s.model && <span>{s.model}</span>}
              {s.request_count > 0 && <span>{s.request_count} req</span>}
              {s.chunk_count > 0 && <span>{s.chunk_count} chunks</span>}
              {s.total_tokens > 0 && <span>{s.total_tokens.toLocaleString()} tok</span>}
              {s.http_429_count > 0 && (
                <span className="text-amber-400">{s.http_429_count}× 429</span>
              )}
            </div>
            {s.error && <p className="mt-1 text-xs text-red-400">{s.error}</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function MediaPanel({
  videoDuration,
  audioDuration,
  mediaBytes,
  publishedAt,
  viewCount,
  likeCount,
  dislikeCount,
  transcriptEnd,
  mediaPath,
  onDeleteMedia,
  deletingMedia,
}: {
  videoDuration?: number | null;
  audioDuration?: number | null;
  mediaBytes: number;
  publishedAt?: string | null;
  viewCount?: number | null;
  likeCount?: number | null;
  dislikeCount?: number | null;
  transcriptEnd?: number | null;
  mediaPath?: string | null;
  onDeleteMedia: () => void;
  deletingMedia: boolean;
}) {
  const pct = (part?: number | null) =>
    videoDuration && part ? Math.min(100, Math.round((part / videoDuration) * 100)) : null;
  const audioPct = pct(audioDuration);
  const covPct = pct(transcriptEnd);
  const ok = (p: number | null) => p !== null && p >= 95;

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold">{MIRROR ? "Media" : "Media & coverage"}</h2>
      <div className="space-y-2 text-sm">
        {publishedAt && <MediaRow label="Published" value={formatDate(publishedAt)} />}
        {viewCount != null && <MediaRow label="Views" value={formatCount(viewCount)} />}
        {likeCount != null && <MediaRow label="Likes" value={formatCount(likeCount)} />}
        {dislikeCount != null && (
          <MediaRow label="Dislikes" value={formatCount(dislikeCount)} />
        )}
        <MediaRow label="Source length" value={formatDuration(videoDuration) || "—"} />
        {!MIRROR && (
          <>
            <MediaRow label="File size" value={formatBytes(mediaBytes)} />
            <MediaRow
              label="Downloaded audio"
              value={
                audioDuration ? (
                  <Coverage
                    text={`${formatDuration(audioDuration)}${audioPct !== null ? ` (${audioPct}%)` : ""}`}
                    ok={ok(audioPct)}
                  />
                ) : (
                  "native transcript"
                )
              }
            />
            <MediaRow
              label="Transcript coverage"
              value={
                transcriptEnd ? (
                  <Coverage
                    text={`${formatDuration(transcriptEnd)}${covPct !== null ? ` (${covPct}%)` : ""}`}
                    ok={ok(covPct)}
                  />
                ) : (
                  "—"
                )
              }
            />
            <MediaRow
              label="Downloaded file"
              value={
                mediaPath ? (
                  <span className="flex items-center gap-2">
                    <a
                      href={`/media/${mediaPath}`}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-primary hover:underline"
                      title={mediaPath}
                    >
                      {mediaPath.split("/").pop()}
                    </a>
                    <button
                      onClick={onDeleteMedia}
                      disabled={deletingMedia}
                      title="Delete the downloaded file (a retry will re-download it)"
                      className="shrink-0 rounded-md border border-border p-1 text-muted-foreground transition-colors hover:border-red-500 hover:text-red-400 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ) : (
                  "—"
                )
              }
            />
          </>
        )}
      </div>
    </Card>
  );
}

function Coverage({ text, ok }: { text: string; ok: boolean }) {
  return (
    <span className={ok ? "text-emerald-400" : "text-amber-400"}>
      {ok ? "✓ " : "⚠ "}
      {text}
    </span>
  );
}

function MediaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function CommentsSection({
  itemId,
  comments,
}: {
  itemId: number;
  comments: Comment[];
}) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["item", itemId] });
  const add = useMutation({
    mutationFn: (text: string) => api.addComment(itemId, text),
    onSuccess: () => {
      setBody("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (commentId: number) => api.deleteComment(itemId, commentId),
    onSuccess: refresh,
  });

  return (
    <Card className="mt-4 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <MessageSquare className="h-4 w-4" /> Comments
        {comments.length > 0 && (
          <span className="text-muted-foreground">({comments.length})</span>
        )}
      </h2>

      <div className="space-y-3">
        {comments.map((c) => (
          <div key={c.id} className="group rounded-md border border-border p-3">
            <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>{timeAgo(c.created_at)}</span>
              <button
                onClick={() => remove.mutate(c.id)}
                className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400"
                title="Delete comment"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="whitespace-pre-wrap text-sm">{c.body}</p>
          </div>
        ))}
        {comments.length === 0 && (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        )}
      </div>

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) add.mutate(body.trim());
        }}
      >
        <textarea
          rows={2}
          placeholder="Add a note or comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="sm" disabled={add.isPending || !body.trim()}>
          {add.isPending ? <Spinner /> : <Send className="h-4 w-4" />}
        </Button>
      </form>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 p-2">
      <div className="text-base font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function formatTs(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
