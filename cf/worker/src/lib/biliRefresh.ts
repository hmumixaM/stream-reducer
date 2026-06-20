// Bilibili web Cookie refresh (orchestration).
//
// The actual HTTP flow runs INSIDE the pipeline container (cf/pipeline/
// bili_refresh.py) so it egresses through WARP — Bilibili risk-controls the
// passport.bilibili.com endpoints (HTTP 412) from the Worker's Cloudflare
// datacenter IP. This Worker side only: loads the stored cookie+token from KV,
// asks the container to refresh, and persists the rolled values back to KV.
import type { Env } from "../env";
import { loadBiliAuth, saveBiliAuth } from "./biliAuth";
import { getContainer } from "@cloudflare/containers";
import { containerKey } from "../pipeline/container";

export interface RefreshOutcome {
  refreshed: boolean;
  reason: string;
}

interface ContainerRefreshResult {
  refreshed?: boolean;
  reason?: string;
  cookie?: string;
  refresh_token?: string;
}

export async function refreshBilibiliCookie(
  env: Env,
  opts: { force?: boolean } = {},
): Promise<RefreshOutcome> {
  const auth = await loadBiliAuth(env);
  if (!auth) return { refreshed: false, reason: "no stored bilibili auth" };
  if (!auth.refresh_token) return { refreshed: false, reason: "no refresh_token (set BILIBILI_REFRESH_TOKEN)" };

  // Run the refresh in the container (WARP egress).
  const instance = getContainer(env.PIPELINE_CONTAINER, containerKey(env, "bili-refresh"));
  const res = await instance.fetch(
    new Request("http://pipeline/refresh-cookie", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: auth.cookie, refresh_token: auth.refresh_token, force: !!opts.force }),
    }),
  );
  if (!res.ok) return { refreshed: false, reason: `container ${res.status}` };
  const out = (await res.json()) as ContainerRefreshResult;

  if (out.refreshed && out.cookie && out.refresh_token) {
    await saveBiliAuth(env, {
      cookie: out.cookie,
      refresh_token: out.refresh_token,
      updated_at: new Date().toISOString(),
    });
  }
  return { refreshed: !!out.refreshed, reason: out.reason ?? "ok" };
}
