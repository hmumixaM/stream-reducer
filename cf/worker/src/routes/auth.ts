import { Hono } from "hono";
import type { AppContext } from "../auth";
import {
  isValidEmail,
  sendMagicLink,
  verifyMagicLink,
  setSessionCookie,
  resolveUser,
  clearSession,
} from "../auth";

export const authRoutes = new Hono<AppContext>();

// Request a magic link. Always returns ok (don't leak which emails exist).
authRoutes.post("/request", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = (body.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) return c.json({ error: "invalid email" }, 400);
  await sendMagicLink(c.env, email);
  return c.json({ ok: true });
});

// Verify a magic link (clicked from email). Sets the session cookie and
// redirects into the app.
authRoutes.get("/verify", async (c) => {
  const token = c.req.query("token") || "";
  const session = token ? await verifyMagicLink(c.env, token) : null;
  if (!session) {
    return c.redirect(`${c.env.APP_ORIGIN}/login?error=invalid_or_expired`);
  }
  setSessionCookie(c, session);
  return c.redirect(`${c.env.APP_ORIGIN}/`);
});

authRoutes.get("/me", async (c) => {
  const user = await resolveUser(c.env, c);
  if (!user) return c.json({ user: null });
  return c.json({ user: { id: user.id, email: user.email, created_at: user.created_at } });
});

authRoutes.post("/logout", async (c) => {
  await clearSession(c.env, c);
  return c.json({ ok: true });
});
