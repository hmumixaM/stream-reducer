import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Clock3, ExternalLink, RefreshCw } from "lucide-react";
import type { BulletinCardItem } from "@/lib/api";
import { formatLength } from "@/lib/utils";

export function BulletinCard({ item, zh, showOverview = false, href = `/bulletin/${item.id}` }: {
  item: BulletinCardItem; zh: boolean; showOverview?: boolean; href?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const points = expanded ? item.bulletin_points : item.bulletin_points.slice(0, 3);
  const pending = zh && item.localization_status !== "done";
  return (
    <article className="desk-story">
      <div className="desk-story-meta"><span className="font-medium text-foreground/80">{item.author || item.platform}</span><span>·</span><span>{item.platform.replace(/_/g, " ")}</span>{item.duration_s ? <span className="ml-auto inline-flex items-center gap-1.5"><Clock3 size={12} />{formatLength(item.duration_s)}</span> : null}</div>
      <Link to={href} className="desk-story-title"><h2>{item.title}</h2></Link>
      {pending && <p className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">{item.localization_status === "queued" || item.localization_status === "processing" ? <><RefreshCw size={11} className="animate-spin" />中文简报准备中</> : <Link to={href} className="hover:underline">中文概览待补齐 · 打开阅读页即可生成</Link>}</p>}
      {showOverview && item.bulletin_overview && <p className="mt-4 text-[15px] leading-8 text-foreground/85" lang={item.bulletin_language === "zh" ? "zh-CN" : undefined}>{item.bulletin_overview}</p>}
      {points.length ? <ul className="desk-story-points" lang={item.bulletin_language === "zh" ? "zh-CN" : undefined}>{points.map((point, i) => <li key={i}>{point.text}</li>)}</ul> : !showOverview || !item.bulletin_overview ? <p className="mt-4 text-sm leading-7 text-foreground/85">{item.summary}</p> : null}
      {item.bulletin_points.length > 3 && <button onClick={() => setExpanded(!expanded)} className="mt-3 text-xs text-muted-foreground hover:text-primary" aria-expanded={expanded}>{expanded ? (zh ? "收起要点" : "Fewer points") : (zh ? `再看 ${item.bulletin_points.length - 3} 条要点` : `${item.bulletin_points.length - 3} more points`)}</button>}
      <div className="desk-story-footer"><Link to={href} className="inline-flex items-center gap-2 font-medium text-primary">{zh ? "阅读精炼概括" : "Read the summary"}<ArrowUpRight size={14} /></Link><a href={item.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"><ExternalLink size={12} />{zh ? "原始来源" : "Original source"}</a></div>
    </article>
  );
}
