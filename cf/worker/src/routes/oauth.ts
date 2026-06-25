import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { AppContext } from "../auth";
import { requireAuth, resolveUser } from "../auth";

export const oauthRoutes = new Hono<AppContext>();

// Short-lived cookie that remembers the OAuth authorize URL across a magic-link
// sign-in, so an unauthenticated user is returned to consent after logging in.
export const OAUTH_RETURN_COOKIE = "sr_oauth_return";

// HTML-escape client-controlled text (client name / id) before rendering it in
// the consent page, so a maliciously-registered client can't inject markup.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Consent screen. If the visitor has no session yet, stash the full authorize
// URL in a cookie and bounce them to the SPA login; they return here after the
// magic-link sign-in (see POST /api/auth/verify). The session cookie is
// SameSite=Lax so the consent POST below can't be driven cross-site (CSRF).
oauthRoutes.get("/authorize", async (c) => {
  const user = await resolveUser(c.env, c);
  if (!user) {
    const returnTo = c.req.path + (new URL(c.req.url).search || "");
    setCookie(c, OAUTH_RETURN_COOKIE, returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 900,
    });
    return c.redirect(`${c.env.APP_ORIGIN}/login`);
  }

  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!clientInfo) return c.text("Invalid client_id", 400);

  const clientLabel = escapeHtml(clientInfo.clientName || clientInfo.clientId);
  const action = `/oauth/authorize?${new URLSearchParams(c.req.query()).toString()}`;

  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Authorize Connection</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 40px auto; padding: 20px; line-height: 1.5; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    .client-name { font-weight: bold; }
    form { margin-top: 2rem; display: flex; gap: 1rem; }
    button { padding: 8px 16px; border-radius: 6px; border: none; font-size: 1rem; cursor: pointer; }
    button[type="submit"] { background: #000; color: white; }
    button[type="button"] { background: #eee; }
  </style>
</head>
<body>
  <h1>Authorize Connection</h1>
  <p>The application <span class="client-name">${clientLabel}</span> would like to access your stream-reduce account.</p>
  <p>This will allow the application to read your library and add new content on your behalf.</p>
  <form method="POST" action="${escapeHtml(action)}">
    <button type="submit">Authorize</button>
    <button type="button" onclick="history.back()">Cancel</button>
  </form>
</body>
</html>`);
});

oauthRoutes.post("/authorize", requireAuth, async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const user = c.get("user");

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.id.toString(),
    metadata: { email: user.email },
    scope: oauthReqInfo.scope || [],
    props: { userId: user.id },
  });

  return c.redirect(redirectTo);
});
