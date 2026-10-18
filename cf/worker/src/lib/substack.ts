import type { Env } from "../env";
import { rssCall, rssCapacityError, type RssBody } from "./rss";

export interface SubstackConnection {
  id: string;
  label: string;
  credentials: string;
  enabled: number;
  status: string;
  expires_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  revision: number;
}
export const CONNECTION_FIELDS = "id,label,enabled,status,expires_at,last_checked_at,last_error";
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function substackCookie(input: string): string {
  if (typeof input !== "string" || input.length > 16000 || /[\r\n]/.test(input))
    throw new Error("请提供有效的 Substack session cookie");
  const cookies = new Map<string, string>();
  for (const part of input.split(";")) {
    const match = part.trim().match(/^(substack\.sid|connect\.sid)=([^\s;]+)$/);
    if (match) cookies.set(match[1], match[2]);
  }
  if (!cookies.size) throw new Error("需要 substack.sid 或 connect.sid cookie");
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
async function credentialKey(env: Env) {
  if (!env.SUBSTACK_CREDENTIAL_KEY || !/^[a-f\d]{64}$/i.test(env.SUBSTACK_CREDENTIAL_KEY))
    throw new Error("服务端尚未配置 Substack 凭据加密密钥");
  return crypto.subtle.importKey("raw", Uint8Array.from(env.SUBSTACK_CREDENTIAL_KEY.match(/../g)!, (v) => parseInt(v, 16)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealSubstackCookie(env: Env, id: string, cookie: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, await credentialKey(env), new TextEncoder().encode(substackCookie(cookie)));
  return JSON.stringify({ v: 1, iv: encode(iv), data: encode(new Uint8Array(encrypted)) });
}
export async function openSubstackCookie(env: Env, connection: SubstackConnection) {
  try {
    const blob = JSON.parse(connection.credentials);
    if (blob.v !== 1) throw new Error("version");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(blob.iv), additionalData: new TextEncoder().encode(connection.id) }, await credentialKey(env), decode(blob.data));
    return substackCookie(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("Substack 凭据不可用，请管理员重新连接");
  }
}
export async function getSubstackConnection(env: Env, id: string) {
  const connection = await env.DB.prepare("SELECT * FROM substack_connection WHERE id=? AND enabled=1").bind(id).first<SubstackConnection>();
  if (!connection) throw new Error("Substack 连接未启用");
  if (connection.status === "needs_auth") throw new Error("Substack 需要重新连接");
  return connection;
}
export async function substackCall<T>(env: Env, connection: SubstackConnection, path: string, data: Record<string, unknown> = {}): Promise<T> {
  try {
    const result = await rssCall<T>(env, `/substack/${path}`, { ...data, cookie: await openSubstackCookie(env, connection) });
    await env.DB.prepare("UPDATE substack_connection SET status='active',last_error=NULL,last_checked_at=? WHERE id=? AND revision=? AND enabled=1")
      .bind(new Date().toISOString(), connection.id, connection.revision).run();
    return result;
  } catch (error) {
    if (rssCapacityError(error)) throw new Error("RSS 抓取服务暂时不可用 (503)");
    // Never persist upstream bodies, account metadata or request headers.
    const reason = String(error);
    const message = reason.includes("SUBSTACK_AUTH") ? "Substack 登录已失效，请管理员重新连接"
      : reason.includes("SUBSTACK_RATE_LIMIT") ? "Substack 请求过多，稍后自动重试"
      : reason.includes("Substack 凭据不可用") ? "Substack 凭据不可用，请管理员重新连接"
      : "Substack 暂时无法访问，稍后重试";
    await env.DB.prepare("UPDATE substack_connection SET status=?,last_error=?,last_checked_at=? WHERE id=? AND revision=?")
      .bind(reason.includes("SUBSTACK_AUTH") ? "needs_auth" : "error", message, new Date().toISOString(), connection.id, connection.revision).run();
    throw new Error(message);
  }
}

export async function extractSubstackArticle(env: Env, articleId: number, postId: string): Promise<RssBody | null> {
  // Different connections may unlock different articles. Content itself is shared.
  const rows = await env.DB.prepare(`SELECT DISTINCT c.* FROM substack_connection c
    JOIN rss_source s ON s.substack_connection_id=c.id
    JOIN rss_source_article sa ON sa.source_id=s.id
    WHERE sa.article_id=? AND c.enabled=1 AND c.status!='needs_auth'
    ORDER BY CASE WHEN c.status='active' THEN 0 ELSE 1 END,c.id LIMIT 4`).bind(articleId).all<SubstackConnection>();
  if (!rows.results.length) throw new Error("Substack 需要重新连接或启用连接");
  let best: RssBody | null = null;
  let failure: unknown;
  for (const connection of rows.results) {
    try {
      const body = await substackCall<RssBody>(env, connection, "extract", { post_id: postId });
      if (body.completeness === "full") return body;
      if (!best || body.word_count > best.word_count) best = body;
    } catch (error) { failure = error; }
  }
  if (!best && failure) throw failure;
  return best;
}
