// Bilibili cookie store. The cookie + its refresh_token (the browser's
// localStorage `ac_time_value`) are persisted in KV so the cron-driven refresh
// (see biliRefresh.ts) can keep them valid indefinitely. The static
// BILIBILI_COOKIE secret is only the initial seed / fallback.
import type { Env } from "../env";

export const BILI_KV_KEY = "bilibili";

export interface BiliAuth {
  // Full browser cookie header: "name=value; name2=value2; …".
  cookie: string;
  // Persistent refresh token (localStorage `ac_time_value`). Empty when the
  // operator only supplied a cookie and no token — refresh is then a no-op.
  refresh_token: string;
  updated_at: string;
}

export async function loadBiliAuth(env: Env): Promise<BiliAuth | null> {
  const raw = await env.BILI_AUTH.get(BILI_KV_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as BiliAuth;
    if (parsed?.cookie) return parsed;
  }
  // First run: seed from the secrets so the very first job/poll already has a
  // cookie (the next refresh persists the rolled values into KV).
  if (env.BILIBILI_COOKIE) {
    return {
      cookie: env.BILIBILI_COOKIE,
      refresh_token: env.BILIBILI_REFRESH_TOKEN ?? "",
      updated_at: "seed",
    };
  }
  return null;
}

export async function saveBiliAuth(env: Env, auth: BiliAuth): Promise<void> {
  await env.BILI_AUTH.put(BILI_KV_KEY, JSON.stringify(auth));
}

// The current Bilibili cookie header for outbound requests (feed APIs + the
// cookie passed to the pipeline container per job). KV first, secret fallback.
export async function getBilibiliCookie(env: Env): Promise<string | undefined> {
  const auth = await loadBiliAuth(env);
  return auth?.cookie || env.BILIBILI_COOKIE || undefined;
}
