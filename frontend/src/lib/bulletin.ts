export function timestampLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
export function sourceAt(source: string, seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return source;
  try {
    const url = new URL(source);
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) url.searchParams.set("t", String(Math.floor(seconds)));
    if (host === "bilibili.com" || host.endsWith(".bilibili.com")) url.searchParams.set("t", String(Math.floor(seconds)));
    return url.toString();
  } catch { return source; }
}
export function readingMinutes(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length || 0;
  const words = text.replace(/[\u3400-\u9fff]/g, " ").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(cjk / 350 + words / 220));
}
export function dateLabel(date: string, zh: boolean): string {
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? (zh ? "近期" : "Recent") : new Intl.DateTimeFormat(zh ? "zh-CN" : "en-US", { month: "long", day: "numeric", year: "numeric" }).format(value);
}
