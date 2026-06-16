import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";

export const oauthRoutes = new Hono<AppContext>();

oauthRoutes.get("/authorize", requireAuth, async (c) => {
  // @ts-ignore
  const oauthApi = c.env.OAUTH_PROVIDER;
  if (!oauthApi) {
    return c.text("OAuth provider not initialized", 500);
  }

  try {
    const oauthReqInfo = await oauthApi.parseAuthRequest(c.req.raw);
    const clientInfo = await oauthApi.lookupClient(oauthReqInfo.clientId);

    if (!clientInfo) {
      return c.text("Invalid client_id", 400);
    }

    const html = `
<!DOCTYPE html>
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
  <p>The application <span class="client-name">${clientInfo.clientName || clientInfo.clientId}</span> would like to access your stream-reduce account.</p>
  <p>This will allow the application to read your library and add new content on your behalf.</p>
  
  <form method="POST" action="/oauth/authorize?${new URLSearchParams(c.req.query()).toString()}">
    <button type="submit">Authorize</button>
    <button type="button" onclick="history.back()">Cancel</button>
  </form>
</body>
</html>
    `;

    return c.html(html);
  } catch (err: any) {
    return c.text(`OAuth Error: ${err.message}`, 400);
  }
});

oauthRoutes.post("/authorize", requireAuth, async (c) => {
  // @ts-ignore
  const oauthApi = c.env.OAUTH_PROVIDER;
  if (!oauthApi) {
    return c.text("OAuth provider not initialized", 500);
  }

  try {
    const oauthReqInfo = await oauthApi.parseAuthRequest(c.req.raw);
    const user = c.get("user");

    const { redirectTo } = await oauthApi.completeAuthorization({
      request: oauthReqInfo,
      userId: user.id.toString(),
      metadata: { email: user.email },
      scope: oauthReqInfo.scope || [],
      props: { userId: user.id },
    });

    return c.redirect(redirectTo);
  } catch (err: any) {
    return c.text(`OAuth Error: ${err.message}`, 400);
  }
});
