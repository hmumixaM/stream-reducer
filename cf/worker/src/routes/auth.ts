import { Hono } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import type { AppContext } from "../auth";
import {
  isValidEmail,
  sendMagicLink,
  verifyMagicLink,
  setSessionCookie,
  resolveUser,
  clearSession,
} from "../auth";
import { readForm, readJson } from "../lib/request";
import { OAUTH_RETURN_COOKIE } from "./oauth";

export const authRoutes = new Hono<AppContext>();

// After a successful sign-in, return the user to a pending OAuth authorize URL
// if one was stashed (and only an on-site /oauth/ path, to avoid open redirect).
function postLoginRedirect(c: Parameters<typeof setSessionCookie>[0]): string {
  const pending = getCookie(c, OAUTH_RETURN_COOKIE);
  if (pending && pending.startsWith("/oauth/")) {
    deleteCookie(c, OAUTH_RETURN_COOKIE, { path: "/" });
    return `${c.env.APP_ORIGIN}${pending}`;
  }
  return `${c.env.APP_ORIGIN}/`;
}

// Request a magic link. Always returns ok (don't leak which emails exist).
authRoutes.post("/request", async (c) => {
  const body = await readJson<{ email?: string }>(c);
  const email = (body.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) return c.json({ error: "invalid email" }, 400);
  try {
    await sendMagicLink(c.env, email);
  } catch (err) {
    if (err instanceof Error && err.message === "rate_limited") {
      return c.json({ error: "Too many sign-in emails. Please try again in a few minutes." }, 429);
    }
    // Email delivery failures (unverified sender/destination, provider outage)
    // shouldn't surface as an opaque 500. Log for the operator and return a
    // clear, actionable error to the client.
    console.error("magic-link send failed", { email, err: String(err) });
    return c.json(
      { error: "Could not send the sign-in email. Please try again later." },
      502,
    );
  }
  return c.json({ ok: true });
});

// Verify a magic link (clicked from email). Sets the session cookie and
// redirects into the app.
authRoutes.get("/verify", async (c) => {
  const token = c.req.query("token") || "";
  if (!token) {
    return c.redirect(`${c.env.APP_ORIGIN}/login?error=invalid_or_expired`);
  }
  return c.html(`<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title></head>
      <body style="font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;background:#0f172a;color:#e5e7eb">
        <form method="post" action="/api/auth/verify" style="max-width:28rem;padding:2rem;border:1px solid #334155;border-radius:1rem;background:#111827">
          <h1 style="margin-top:0">Sign in to stream-reduce</h1>
          <p>Email security scanners sometimes open links automatically, so click the button below to finish signing in.</p>
          <input type="hidden" name="token" value="${token.replace(/"/g, "&quot;")}">
          <button style="padding:.65rem 1rem;border:0;border-radius:.5rem;background:#818cf8;color:#fff;font-weight:600">Continue</button>
        </form>
      </body>
    </html>`);
});

authRoutes.post("/verify", async (c) => {
  const contentType = c.req.header("content-type") || "";
  let token = "";
  if (contentType.includes("application/json")) {
    const body = await readJson<{ token?: string }>(c);
    token = body.token || "";
  } else {
    const body = await readForm(c);
    token = typeof body.token === "string" ? body.token : "";
  }
  const session = token ? await verifyMagicLink(c.env, token) : null;
  if (!session) {
    return c.redirect(`${c.env.APP_ORIGIN}/login?error=invalid_or_expired`);
  }
  setSessionCookie(c, session);
  return c.redirect(postLoginRedirect(c));
});

authRoutes.get("/me", async (c) => {
  const user = await resolveUser(c.env, c);
  if (!user) return c.json({ user: null });
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      is_admin: !!user.is_admin,
      created_at: user.created_at,
    },
  });
});

authRoutes.post("/logout", async (c) => {
  await clearSession(c.env, c);
  return c.json({ ok: true });
});
