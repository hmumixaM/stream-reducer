import { type ReactNode, useId } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { api, type BulletinItem, type Platform } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { dateLabel } from "@/lib/bulletin";
import { formatBytes, formatCount, formatDuration } from "@/lib/utils";
import { PLATFORM_LABELS } from "@/components/badges";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm leading-relaxed">{children}</dd></div>;
}

function plainDescription(raw: string) {
  return raw.replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'").replace(/\n{3,}/g, "\n\n").trim();
}

/** Source facts stay visible in every reading view, independently of translation. */
export function ProgramInfo({ item, zh }: { item: BulletinItem; zh: boolean }) {
  const heading = useId();
  const me = useMe();
  const metadata = useQuery({
    queryKey: ["item", item.id, me.data?.user?.id, me.data?.user?.preferred_language || "auto"],
    queryFn: () => api.getItem(item.id),
  });
  const data = metadata.data;
  const duration = data?.duration_s ?? item.duration_s;
  const published = data?.published_at || item.published_at;
  const language = data?.transcript?.language || item.source_language;
  const languageName = language ? (/^(en(?:[-_].+)?|english)$/i.test(language) ? "English" : /^(zh(?:[-_].+)?|chinese)$/i.test(language) ? "中文" : language) : null;
  const description = plainDescription(data?.description || "");
  const source = item.channel?.title || item.author;
  const transcript = data?.transcript;
  const transcriptEnd = transcript?.segments?.reduce((end, segment) => Math.max(end, segment.end || 0), 0);
  const coverage = transcriptEnd && duration ? Math.min(100, Math.round(transcriptEnd / duration * 100)) : null;
  const transcriptSource = transcript?.source === "native" ? (zh ? "原生字幕" : "Native captions") : transcript?.source === "stt" ? (zh ? "语音转录" : "Speech transcription") : transcript?.source;
  return <section aria-labelledby={heading} className="program-info mb-5 break-words rounded-lg border bg-card px-4 py-3 sm:px-5">
    <h2 id={heading} className="mb-3 text-sm font-semibold">{zh ? "节目信息" : "Program information"}</h2>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      <Field label={zh ? "节目 / 发布者" : "Show / publisher"}>{source ? item.channel ? <Link className="underline underline-offset-4" to={`/channels/${item.channel.id}`}>{source}</Link> : source : (zh ? "未提供" : "Not provided")}</Field>
      <Field label={zh ? "平台" : "Platform"}><a href={item.source_url} target="_blank" rel="noreferrer" className="underline underline-offset-4">{PLATFORM_LABELS[item.platform as Platform] || item.platform}</a></Field>
      <Field label={zh ? "发布时间" : "Published"}>{published ? <time dateTime={published}>{dateLabel(published, zh)}</time> : (zh ? "未提供" : "Not provided")}</Field>
      <Field label={zh ? "节目时长" : "Source duration"}>{formatDuration(duration) || (zh ? "未提供" : "Not provided")}</Field>
      {languageName && <Field label={zh ? "原始语言" : "Original language"}>{languageName}</Field>}
      {data?.view_count != null && <Field label={zh ? "播放量" : "Views"}>{formatCount(data.view_count)}</Field>}
      {data?.like_count != null && <Field label={zh ? "点赞" : "Likes"}>{formatCount(data.like_count)}</Field>}
      {data?.dislike_count != null && <Field label={zh ? "不喜欢" : "Dislikes"}>{formatCount(data.dislike_count)}</Field>}
      {item.author && item.channel?.title && item.author !== item.channel.title && <Field label={zh ? "作者" : "Author"}>{item.author}</Field>}
    </dl>
    {metadata.isError && <p role="status" className="mt-3 text-sm text-muted-foreground">{zh ? "部分节目信息暂时无法加载。" : "Some program details could not load."}<button className="reader-control" onClick={() => metadata.refetch()}>{zh ? "重试" : "Retry"}</button></p>}
    <details className="group mt-3 border-t pt-1">
      <summary className="reader-control justify-start px-0"><ChevronDown size={15} aria-hidden className="shrink-0 group-open:rotate-180" />{zh ? "节目说明与媒体详情" : "Show notes & media details"}</summary>
      <div className="space-y-4 pb-2 text-sm leading-relaxed">
        <dl><Field label={zh ? "原始标题" : "Original title"}><a href={item.source_url} target="_blank" rel="noreferrer" className="underline underline-offset-4">{item.source_title}</a></Field></dl>
        {description && <div><h3 className="mb-2 font-medium">{zh ? "节目说明" : "Show notes"}</h3><p className="max-h-72 overflow-y-auto whitespace-pre-line break-words">{description}</p></div>}
        {item.background && <div><h3 className="mb-2 font-medium">{zh ? "节目背景" : "Program background"}</h3><p>{item.background}</p></div>}
        {item.atmosphere && <div><h3 className="mb-2 font-medium">{zh ? "对话氛围" : "Conversation style"}</h3><p>{item.atmosphere}</p></div>}
        {!!item.entities?.length && <div><h3 className="mb-2 font-medium">{zh ? "相关人物与主题" : "People & topics"}</h3><p>{item.entities.join(" · ")}</p></div>}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {transcriptSource && <Field label={zh ? "逐字稿来源" : "Transcript source"}>{transcriptSource}</Field>}
          {!!transcriptEnd && <Field label={zh ? "逐字稿覆盖" : "Transcript coverage"}>{formatDuration(transcriptEnd)}{coverage != null ? ` (${coverage}%)` : ""}</Field>}
          {!!data?.audio_duration_s && <Field label={zh ? "已下载音频" : "Downloaded audio"}>{formatDuration(data.audio_duration_s)}</Field>}
          {!!data?.media_bytes && <Field label={zh ? "媒体大小" : "Media size"}>{formatBytes(data.media_bytes)}</Field>}
          {data?.media_path && <Field label={zh ? "媒体文件" : "Media file"}><a href={`/media/${data.media_path}`} target="_blank" rel="noreferrer" className="underline underline-offset-4">{zh ? "打开已保存媒体" : "Open saved media"}</a></Field>}
        </dl>
      </div>
    </details>
  </section>;
}
