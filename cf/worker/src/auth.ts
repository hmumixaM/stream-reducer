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
  const since = new Date(Date.now() - MAGIC_LINK_WINDOW_MS).toISOString();
  // Sweeping spent tokens and counting recent ones travel together: the user is
  // watching a spinner until the email is away, so spend one round trip, not two.
  const [, recent] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("DELETE FROM auth_token WHERE expires_at < ? OR used_at IS NOT NULL").bind(isoNow()),
    env.DB
      .prepare("SELECT COUNT(*) AS n FROM auth_token WHERE email = ? AND created_at >= ?")
      .bind(email, since),
  ]);
  if ((recent.results[0]?.n ?? 0) >= MAGIC_LINK_MAX_PER_WINDOW) {
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

  const sessionToken = randomToken();
  const sessionHash = await sha256(sessionToken);
  const admins = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  // Burning the token, finding-or-creating the user, and minting the session
  // are one atomic batch — a single D1 round trip instead of five sequential
  // ones, on the path a person waits through after clicking the email link.
  // The session INSERT reads the user id back through a subselect, so nothing
  // here has to come back to the Worker first.
  const statements = [
    env.DB.prepare("UPDATE auth_token SET used_at = ? WHERE id = ?").bind(isoNow(), row.id),
    env.DB.prepare("INSERT INTO user (email) VALUES (?) ON CONFLICT(email) DO NOTHING").bind(row.email),
  ];
  if (admins.includes(row.email.toLowerCase())) {
    statements.push(env.DB.prepare("UPDATE user SET is_admin = 1 WHERE email = ?").bind(row.email));
  }
  statements.push(
    env.DB
      .prepare(
        `INSERT INTO session (token_hash, user_id, expires_at)
         SELECT ?, id, ? FROM user WHERE email = ?`,
      )
      .bind(sessionHash, isoIn(SESSION_TTL_MS), row.email),
  );

  const results = await env.DB.batch(statements);
  const created = results[results.length - 1].meta.changes;
  if (!created) return null;
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
  // Every authenticated request pays this lookup, and the session shell of the
  // SPA waits on it before anything renders, so resolve it in ONE round trip:
  // the session row and its user used to be two sequential D1 queries.
  const row = await first<UserRow & { session_expires_at: string }>(
    env.DB.prepare(
      `SELECT u.*, s.expires_at AS session_expires_at
         FROM session s JOIN user u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    ).bind(hash),
  );
  if (!row || row.session_expires_at < isoNow()) return null;
  const { session_expires_at: _expires, ...user } = row;
  return user as UserRow;
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

// Middleware: requires an authenticated admin, else 401/403.
// Headless escape hatch: a request carrying a valid `x-admin-token` (matching
// the ADMIN_TOKEN secret) passes as a synthetic admin, for one-off maintenance.
export async function requireAdmin(c: Context<AppContext>, next: Next) {
  const adminToken = c.env.ADMIN_TOKEN;
  const provided = c.req.header("x-admin-token");
  if (adminToken && provided && provided === adminToken) {
    c.set("user", { id: 0, email: "admin-token", is_admin: 1, created_at: isoNow() } as UserRow);
    await next();
    return;
  }
  const user = await resolveUser(c.env, c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  if (!user.is_admin) return c.json({ error: "forbidden" }, 403);
  c.set("user", user);
  await next();
}
