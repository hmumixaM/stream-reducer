import { useState, useEffect, useMemo, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  Highlighter,
  Languages,
  Sparkles,
  Image as ImageIcon,
} from "lucide-react";
import {
  api,
  TRANSLATE_LANGS,
  type StageRun,
  type Comment,
  type Highlight,
  type NewHighlight,
  type Infographic,
} from "@/lib/api";
import { MIRROR } from "@/lib/mirror";
import { useMe } from "@/lib/auth";
import { Button, Card, Select, Spinner } from "@/components/ui";
import { PlatformBadge, StatusBadge } from "@/components/badges";
import { RelatedArticles } from "@/components/RelatedArticles";
import { HighlightableMarkdown, HighlightLayer, hlClass } from "@/components/Highlightable";
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
  const me = useMe();
  // Personal actions (favorite, archive, comments, highlights, retry, delete)
  // need a session; anonymous visitors get a read-only view.
  const canEdit = !MIRROR && !!me.data?.user;
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
  const interest = useMutation({
    mutationFn: () => api.toggleInterest(itemId),
    onSuccess: invalidate,
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

  const refreshAnnotations = () => {
    qc.invalidateQueries({ queryKey: ["item", itemId] });
    qc.invalidateQueries({ queryKey: ["annotations"] });
  };
  const addHighlight = useMutation({
    mutationFn: (h: NewHighlight) => api.addHighlight(itemId, h),
    onSuccess: refreshAnnotations,
  });
  const updateHighlight = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      api.updateHighlight(itemId, id, { note }),
    onSuccess: refreshAnnotations,
  });
  const deleteHighlight = useMutation({
    mutationFn: (id: number) => api.deleteHighlight(itemId, id),
    onSuccess: refreshAnnotations,
  });

  if (item.isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (item.isError || !item.data)
    return <p className="text-red-400">Failed to load item.</p>;

  const d = item.data;
  const summaryHighlights = d.highlights?.filter((h) => h.source === "summary") ?? [];
  const transcriptHighlights = d.highlights?.filter((h) => h.source === "transcript") ?? [];
  const onCreateHighlight = (h: NewHighlight) => addHighlight.mutate(h);
  const onUpdateHighlight = (id: number, note: string) =>
    updateHighlight.mutate({ id, note });
  const onDeleteHighlight = (id: number) => deleteHighlight.mutate(id);

  return (
    <div className={readMode ? "mx-auto max-w-3xl" : ""}>
      <Link
        to={me.data?.user ? "/" : "/browse"}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {me.data?.user ? "Library" : "Browse"}
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
          {!readMode && canEdit && (
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
          {!readMode && canEdit &&
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
          {!readMode && canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => interest.mutate()}
              disabled={interest.isPending}
              title={d.is_interested ? "You're interested — boosts processing priority" : "Mark interest to boost processing priority"}
            >
              <Star className={cn("h-4 w-4", d.is_interested && "fill-amber-400 text-amber-400")} />
              <span className="hidden sm:inline">{d.is_interested ? "Interested" : "Mark interest"}</span>
              {!!d.interest_count && (
                <span className="text-xs text-muted-foreground">{d.interest_count}</span>
              )}
            </Button>
          )}
          {!readMode && canEdit && (
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
          {d.summary && (
            <InfographicView
              itemId={itemId}
              initial={d.infographic ?? null}
              authed={!!me.data?.user}
              readMode={readMode}
            />
          )}

          {d.description && <ShowNotesView description={d.description} readMode={readMode} />}

          {d.summary ? (
            <SummaryView
              itemId={itemId}
              summaryMarkdown={d.summary.markdown}
              translations={d.translations ?? []}
              readMode={readMode}
              canEdit={canEdit}
              authed={!!me.data?.user}
              summaryHighlights={summaryHighlights}
              onCreate={onCreateHighlight}
              onUpdateNote={onUpdateHighlight}
              onDelete={onDeleteHighlight}
            />
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
                <TranscriptBody
                  segments={d.transcript.segments}
                  highlights={transcriptHighlights}
                  readOnly={!canEdit}
                  onCreate={onCreateHighlight}
                  onUpdateNote={onUpdateHighlight}
                  onDelete={onDeleteHighlight}
                />
              )}
            </Card>
          )}

          {d.highlights.length > 0 && (
            <HighlightsList
              highlights={d.highlights}
              readOnly={!canEdit}
              onDelete={onDeleteHighlight}
            />
          )}

          {canEdit && (
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

      {["done", "error"].includes(d.status) && <RelatedArticles itemId={itemId} />}
    </div>
  );
}

// Flatten show-notes HTML (podcast feeds store <p>/<br>/links) into readable
// plain text so the original notes are visible alongside the AI summary.
function shownotesToText(raw: string): string {
  return raw
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The original podcast/show notes (chapters, references), shown above the AI
// summary. Collapsible since they can be long.
function ShowNotesView({ description, readMode }: { description: string; readMode: boolean }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => shownotesToText(description), [description]);
  if (!text) return null;
  return (
    <Card className={cn("mb-4 p-4", readMode && "border-dashed bg-transparent shadow-none")}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" /> Show notes
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <p className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {text}
        </p>
      )}
    </Card>
  );
}

// Summary with an on-demand language switcher. "Original" shows the stored
// summary (editable highlights); other languages show a shared translation,
// regenerated from the transcript on first request and cached for everyone.
function SummaryView({
  itemId,
  summaryMarkdown,
  translations,
  readMode,
  canEdit,
  authed,
  summaryHighlights,
  onCreate,
  onUpdateNote,
  onDelete,
}: {
  itemId: number;
  summaryMarkdown: string;
  translations: { lang: string; status: string }[];
  readMode: boolean;
  canEdit: boolean;
  authed: boolean;
  summaryHighlights: Highlight[];
  onCreate: (h: NewHighlight) => void;
  onUpdateNote: (id: number, note: string) => void;
  onDelete: (id: number) => void;
}) {
  const [lang, setLang] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const qc = useQueryClient();
  const mdClass = readMode ? "prose-read max-w-none" : "prose-sr max-w-none text-sm";

  const labelFor = (code: string) => TRANSLATE_LANGS.find((l) => l.code === code)?.label ?? code;
  // Languages already translated (or in progress) become one-click chips.
  const available = [...translations].sort((a, b) => labelFor(a.lang).localeCompare(labelFor(b.lang)));
  const availSet = new Set(translations.map((t) => t.lang));
  const remaining = TRANSLATE_LANGS.filter((l) => !availSet.has(l.code));

  const translation = useQuery({
    queryKey: ["translation", itemId, lang],
    queryFn: () => api.getTranslation(itemId, lang!),
    enabled: lang != null,
    retry: false,
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === "queued" || q.state.data.status === "processing")
        ? 3000
        : false,
  });

  // Requesting a translation is a deliberate, confirmed action so users don't
  // accidentally spawn many jobs. Existing translations are just viewed.
  const request = useMutation({
    mutationFn: (code: string) => api.requestTranslation(itemId, code),
    onSuccess: (_data, code) => {
      qc.invalidateQueries({ queryKey: ["item", itemId] });
      qc.invalidateQueries({ queryKey: ["translation", itemId, code] });
      setLang(code);
      setPick("");
    },
  });

  const requestPick = () => {
    if (!pick) return;
    if (confirm(`Generate a ${labelFor(pick)} translation? It runs a one-time job and is then shared with everyone.`)) {
      request.mutate(pick);
    }
  };

  return (
    <Card className={readMode ? "border-none bg-transparent shadow-none" : "p-6"}>
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        <Languages className="mr-1 h-4 w-4 text-muted-foreground" />
        <LangChip label="Original" active={lang === null} onClick={() => setLang(null)} />
        {available.map((t) => (
          <LangChip
            key={t.lang}
            label={labelFor(t.lang) + (t.status === "done" ? "" : " …")}
            active={lang === t.lang}
            onClick={() => setLang(t.lang)}
          />
        ))}
        {authed && remaining.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            <Select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="h-8 w-auto py-0 text-xs"
            >
              <option value="">Translate to…</option>
              {remaining.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </Select>
            <Button size="sm" variant="outline" disabled={!pick || request.isPending} onClick={requestPick}>
              {request.isPending ? <Spinner /> : <Languages className="h-4 w-4" />} Translate
            </Button>
          </span>
        )}
        {!authed && remaining.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">Sign in to request a translation</span>
        )}
      </div>

      {lang === null ? (
        <HighlightableMarkdown
          markdown={summaryMarkdown}
          highlights={summaryHighlights}
          source="summary"
          readOnly={!canEdit}
          onCreate={onCreate}
          onUpdateNote={onUpdateNote}
          onDelete={onDelete}
          className={mdClass}
        />
      ) : translation.data?.status === "done" ? (
        <HighlightableMarkdown
          markdown={translation.data.markdown}
          highlights={[]}
          source="summary"
          readOnly
          onCreate={() => {}}
          onUpdateNote={() => {}}
          onDelete={() => {}}
          className={mdClass}
        />
      ) : translation.data?.status === "error" ? (
        <div className="space-y-3 text-sm text-red-400">
          <p>Translation failed.{translation.data.error ? ` ${translation.data.error}` : ""}</p>
          {authed && (
            <Button size="sm" variant="outline" onClick={() => request.mutate(lang!)} disabled={request.isPending}>
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Translating to {labelFor(lang!)}… generated once and shared with everyone. This can take a minute.
        </div>
      )}
    </Card>
  );
}

// On-demand infographic poster: instead of auto-generating a visual for every
// item, a signed-in user clicks "Generate" to render a paid image-model poster,
// which is then cached + shared with everyone.
function InfographicView({
  itemId,
  initial,
  authed,
  readMode,
}: {
  itemId: number;
  initial: Infographic | null;
  authed: boolean;
  readMode: boolean;
}) {
  const qc = useQueryClient();
  // Only poll once a row exists (initial detail payload, or after a request).
  const [started, setStarted] = useState(!!initial);

  const ig = useQuery({
    queryKey: ["infographic", itemId],
    queryFn: () => api.getInfographic(itemId),
    initialData: initial ?? undefined,
    enabled: started,
    retry: false,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "queued" || s === "processing" ? 3000 : false;
    },
  });

  const request = useMutation({
    mutationFn: () => api.requestInfographic(itemId),
    onSuccess: (data) => {
      qc.setQueryData(["infographic", itemId], data);
      setStarted(true);
      qc.invalidateQueries({ queryKey: ["item", itemId] });
    },
  });

  const data = ig.data ?? initial ?? null;
  const status = data?.status;
  const pending = request.isPending || status === "queued" || status === "processing";

  const Header = (
    <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between z-10 bg-gradient-to-r from-blue-500/10 to-transparent">
      <h3 className="text-sm font-semibold flex items-center gap-2 text-blue-100 tracking-wide">
        <ImageIcon className="h-4 w-4 text-blue-400" /> Infographic
      </h3>
      {status === "done" && authed && (
        <button
          onClick={() => request.mutate()}
          disabled={pending}
          className="text-xs text-blue-300/70 hover:text-blue-200 flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" /> Regenerate
        </button>
      )}
    </div>
  );

  // Nothing rendered yet: invite a generation (or prompt sign-in).
  const Body = () => {
    if (status === "done" && data?.image_url) {
      return (
        <img
          src={data.image_url}
          alt="Generated infographic summary"
          className="w-full h-auto rounded-lg shadow-lg"
          loading="lazy"
        />
      );
    }
    if (pending) {
      return (
        <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
          <Spinner />
          Rendering infographic… generated once and shared with everyone. This can take ~30s.
        </div>
      );
    }
    if (status === "error") {
      return (
        <div className="flex flex-col items-center gap-3 py-8 text-sm text-red-400">
          <p>Infographic generation failed.{data?.error ? ` ${data.error}` : ""}</p>
          {authed && (
            <Button size="sm" variant="outline" onClick={() => request.mutate()} disabled={pending}>
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
          )}
        </div>
      );
    }
    // No infographic yet.
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Sparkles className="h-7 w-7 text-blue-400/80" />
        <p className="text-sm text-muted-foreground max-w-sm">
          Turn this summary into a shareable infographic poster, rendered by an
          image model on request.
        </p>
        {authed ? (
          <Button size="sm" onClick={() => request.mutate()} disabled={request.isPending}>
            {request.isPending ? <Spinner /> : <Sparkles className="h-4 w-4" />} Generate infographic
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Sign in to generate an infographic</span>
        )}
      </div>
    );
  };

  return (
    <div className={cn("mb-6 relative group rounded-2xl overflow-hidden", readMode ? "border-dashed bg-transparent shadow-none" : "")}>
      <div className={cn("relative w-full overflow-hidden flex flex-col bg-slate-950/80 backdrop-blur-xl border", readMode ? "border-dashed border-border" : "border-white/10 rounded-2xl")}>
        {Header}
        <div className="p-4 sm:p-6 z-10 w-full">
          <Body />
        </div>
      </div>
    </div>
  );
}

function LangChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
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

function TranscriptBody({
  segments,
  highlights,
  readOnly,
  onCreate,
  onUpdateNote,
  onDelete,
}: {
  segments: { start: number; end: number; text: string }[];
  highlights: Highlight[];
  readOnly: boolean;
  onCreate: (h: NewHighlight) => void;
  onUpdateNote: (id: number, note: string) => void;
  onDelete: (id: number) => void;
}) {
  const body = useMemo(
    () => (
      <div className="space-y-1">
        {segments.map((seg, i) => (
          <p key={i}>
            <span className="mr-2 font-mono text-xs text-primary">{formatTs(seg.start)}</span>
            {seg.text}
          </p>
        ))}
      </div>
    ),
    [segments],
  );
  return (
    <HighlightLayer
      highlights={highlights}
      source="transcript"
      readOnly={readOnly}
      onCreate={onCreate}
      onUpdateNote={onUpdateNote}
      onDelete={onDelete}
      className="mt-3 max-h-96 overflow-auto text-sm text-muted-foreground"
    >
      {body}
    </HighlightLayer>
  );
}

function HighlightsList({
  highlights,
  readOnly,
  onDelete,
}: {
  highlights: Highlight[];
  readOnly: boolean;
  onDelete: (id: number) => void;
}) {
  return (
    <Card className="mt-4 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Highlighter className="h-4 w-4" /> Highlights
        <span className="text-muted-foreground">({highlights.length})</span>
      </h2>
      <div className="space-y-3">
        {highlights.map((h) => (
          <div key={h.id} className="group flex gap-3 rounded-md border border-border p-3">
            <span className={cn("mt-1 h-3 w-3 shrink-0 rounded-full", hlClass(h.color))} />
            <div className="min-w-0 flex-1">
              <p className="text-sm italic text-muted-foreground">“{h.quote}”</p>
              {h.note && <p className="mt-1 whitespace-pre-wrap text-sm">{h.note}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                {h.source} · {timeAgo(h.created_at)}
              </p>
            </div>
            {!readOnly && (
              <button
                onClick={() => onDelete(h.id)}
                title="Delete highlight"
                className="self-start opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
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
