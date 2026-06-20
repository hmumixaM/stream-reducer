// Bilibili web Cookie refresh.
//
// Bilibili's web cookies decay as "sensitive" endpoints are hit; the official
// mechanism is to periodically refresh them with a persistent refresh_token.
// Flow (see https://github.com/SocialSisterYi/bilibili-API-collect login docs):
//   1. GET  /x/passport-login/web/cookie/info?csrf=<bili_jct>  -> {refresh, timestamp}
//   2. correspondPath = hex(RSA-OAEP-SHA256(pubkey, "refresh_"+timestamp))
//      GET https://www.bilibili.com/correspond/1/<path>        -> #1-name = refresh_csrf
//   3. POST /x/passport-login/web/cookie/refresh               -> new Set-Cookie + new refresh_token
//   4. POST /x/passport-login/web/confirm/refresh (new csrf, OLD token) -> invalidate old cookie
// New cookie + refresh_token are persisted back to KV.
import type { Env } from "../env";
import { loadBiliAuth, saveBiliAuth } from "./biliAuth";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Bilibili's well-known RSA public key (JWK) for correspondPath generation.
const PUBKEY_JWK: JsonWebKey = {
  kty: "RSA",
  n: "y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE",
  e: "AQAB",
};

export interface RefreshOutcome {
  refreshed: boolean;
  reason: string;
}

function parseCookie(s: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (s || "").split(";")) {
    const t = part.trim();
    const i = t.indexOf("=");
    if (i <= 0) continue;
    jar.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return jar;
}

function serializeCookie(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// Apply Set-Cookie response headers onto the jar (name=value, ignoring attrs).
function mergeSetCookies(jar: Map<string, string>, setCookies: string[]): void {
  for (const sc of setCookies) {
    const first = (sc.split(";", 1)[0] || "").trim();
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (value && value.toLowerCase() !== "deleted") jar.set(name, value);
  }
}

async function correspondPath(timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    PUBKEY_JWK,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const data = new TextEncoder().encode(`refresh_${timestamp}`);
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, data));
  let hex = "";
  for (const b of enc) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function biliGetJson(url: string, cookie: string): Promise<Record<string, any>> {
  const res = await fetch(url, { headers: { "user-agent": UA, cookie } });
  return (await res.json()) as Record<string, any>;
}

// workerd supports Headers.getSetCookie() at runtime (one entry per Set-Cookie),
// but it isn't in @cloudflare/workers-types yet.
function getSetCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  return h.getSetCookie ? h.getSetCookie() : [];
}

// Refresh the stored Bilibili cookie if Bilibili says it needs it (or force).
// Returns whether an actual refresh happened. Throws on a hard failure mid-flow
// (caller logs; the previous cookie stays in KV untouched).
export async function refreshBilibiliCookie(
  env: Env,
  opts: { force?: boolean } = {},
): Promise<RefreshOutcome> {
  const auth = await loadBiliAuth(env);
  if (!auth) return { refreshed: false, reason: "no stored bilibili auth" };
  if (!auth.refresh_token) return { refreshed: false, reason: "no refresh_token (set BILIBILI_REFRESH_TOKEN)" };

  const jar = parseCookie(auth.cookie);
  const csrf = jar.get("bili_jct");
  if (!csrf) return { refreshed: false, reason: "stored cookie missing bili_jct" };

  // 1. Does it need refreshing?
  const info = await biliGetJson(
    `https://passport.bilibili.com/x/passport-login/web/cookie/info?csrf=${csrf}`,
    auth.cookie,
  );
  if (info.code !== 0) return { refreshed: false, reason: `cookie/info code=${info.code} ${info.message ?? ""}` };
  const timestamp: number = info.data?.timestamp ?? Date.now();
  if (!info.data?.refresh && !opts.force) return { refreshed: false, reason: "cookie still fresh" };

  // 2. correspondPath -> refresh_csrf
  const path = await correspondPath(timestamp);
  const html = await (
    await fetch(`https://www.bilibili.com/correspond/1/${path}`, {
      headers: { "user-agent": UA, cookie: auth.cookie },
    })
  ).text();
  const match = html.match(/<div id="1-name">\s*([0-9a-fA-F]+)\s*<\/div>/);
  if (!match) throw new Error("refresh_csrf not found (correspondPath expired or cookie invalid)");
  const refreshCsrf = match[1];

  // 3. Refresh -> new Set-Cookie + new refresh_token. Keep the OLD token for step 4.
  const oldToken = auth.refresh_token;
  const refreshRes = await fetch("https://passport.bilibili.com/x/passport-login/web/cookie/refresh", {
    method: "POST",
    headers: { "user-agent": UA, cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, refresh_csrf: refreshCsrf, source: "main_web", refresh_token: oldToken }).toString(),
  });
  const setCookies = getSetCookies(refreshRes);
  const refreshJson = (await refreshRes.json()) as Record<string, any>;
  if (refreshJson.code !== 0) {
    throw new Error(`cookie/refresh code=${refreshJson.code} ${refreshJson.message ?? ""}`);
  }
  const newToken: string | undefined = refreshJson.data?.refresh_token;
  if (!newToken) throw new Error("cookie/refresh returned no refresh_token");

  mergeSetCookies(jar, setCookies);
  const newCsrf = jar.get("bili_jct");
  if (!newCsrf) throw new Error("refreshed cookie missing bili_jct");
  const newCookie = serializeCookie(jar);

  // 4. Confirm with the NEW csrf and the OLD token (invalidates the old cookie).
  const confirmRes = await fetch("https://passport.bilibili.com/x/passport-login/web/confirm/refresh", {
    method: "POST",
    headers: { "user-agent": UA, cookie: newCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: newCsrf, refresh_token: oldToken }).toString(),
  });
  const confirmJson = (await confirmRes.json()) as Record<string, any>;
  if (confirmJson.code !== 0) {
    // The new cookie is already valid; failing to invalidate the old one is
    // non-fatal, so persist and warn rather than discarding the refresh.
    console.warn("bilibili confirm/refresh non-zero", confirmJson.code, confirmJson.message);
  }

  await saveBiliAuth(env, { cookie: newCookie, refresh_token: newToken, updated_at: new Date().toISOString() });
  return { refreshed: true, reason: "ok" };
}
