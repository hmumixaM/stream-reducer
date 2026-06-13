import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./env";
import { first, type UserRow } from "./db";
import { randomToken, sha256, isoNow, isoIn } from "./lib/crypto";

const SESSION_COOKIE = "sr_session";
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAGIC_LINK_MAX_PER_WINDOW = 3;
const MAGIC_LINK_WINDOW_MS = 10 * 60 * 1000;

export type AppContext = {
  Bindings: Env;
  Variables: { user: UserRow };
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// Create a single-use magic-link token for `email` and email the link.
export async function sendMagicLink(env: Env, email: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM auth_token WHERE expires_at < ? OR used_at IS NOT NULL",
  ).bind(isoNow()).run();
  const since = new Date(Date.now() - MAGIC_LINK_WINDOW_MS).toISOString();
  const recent = await first<{ n: number }>(
    env.DB.prepare("SELECT COUNT(*) AS n FROM auth_token WHERE email = ? AND created_at >= ?").bind(email, since),
  );
  if ((recent?.n ?? 0) >= MAGIC_LINK_MAX_PER_WINDOW) {
    throw new Error("rate_limited");
  }

  const token = randomToken();
  const hash = await sha256(token);
  await env.DB.prepare(
    `INSERT INTO auth_token (token_hash, email, purpose, expires_at) VALUES (?, ?, 'magic_link', ?)`,
  )
    .bind(hash, email, isoIn(MAGIC_LINK_TTL_MS))
    .run();

  const link = `${env.APP_ORIGIN}/api/auth/verify?token=${token}`;
  await env.EMAIL.send({
    to: email,
    from: env.EMAIL_FROM,
    subject: "Sign in to stream-reduce",
    text: `Click to sign in: ${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
    html: `<h2>Sign in to stream-reduce</h2>
      <p><a href="${link}">Click here to sign in</a></p>
      <p style="color:#666">This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`,
  });
}

// Consume a magic-link token, find-or-create the user, and mint a session.
// Returns the raw session token (to set as a cookie) or null when invalid.
export async function verifyMagicLink(env: Env, token: string): Promise<string | null> {
  const hash = await sha256(token);
  const row = await first<{ id: number; email: string; expires_at: string; used_at: string | null }>(
    env.DB.prepare(
      "SELECT id, email, expires_at, used_at FROM auth_token WHERE token_hash = ?",
    ).bind(hash),
  );
  if (!row || row.used_at || row.expires_at < isoNow()) return null;

  await env.DB.prepare("UPDATE auth_token SET used_at = ? WHERE id = ?")
    .bind(isoNow(), row.id)
    .run();

  // Find-or-create the user by email.
  await env.DB.prepare("INSERT INTO user (email) VALUES (?) ON CONFLICT(email) DO NOTHING")
    .bind(row.email)
    .run();
  const user = await first<UserRow>(
    env.DB.prepare("SELECT * FROM user WHERE email = ?").bind(row.email),
  );
  if (!user) return null;

  const sessionToken = randomToken();
  const sessionHash = await sha256(sessionToken);
  await env.DB.prepare(
    "INSERT INTO session (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(sessionHash, user.id, isoIn(SESSION_TTL_MS))
    .run();
  return sessionToken;
}

export function setSessionCookie(c: Context<AppContext>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function resolveUser(env: Env, c: Context<AppContext>): Promise<UserRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256(token);
  const session = await first<{ user_id: number; expires_at: string }>(
    env.DB.prepare("SELECT user_id, expires_at FROM session WHERE token_hash = ?").bind(hash),
  );
  if (!session || session.expires_at < isoNow()) return null;
  return first<UserRow>(
    env.DB.prepare("SELECT * FROM user WHERE id = ?").bind(session.user_id),
  );
}

export async function clearSession(env: Env, c: Context<AppContext>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const hash = await sha256(token);
    await env.DB.prepare("DELETE FROM session WHERE token_hash = ?").bind(hash).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

// Middleware: requires an authenticated user, else 401.
export async function requireAuth(c: Context<AppContext>, next: Next) {
  const user = await resolveUser(c.env, c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
}
