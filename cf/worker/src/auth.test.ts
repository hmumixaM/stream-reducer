import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppContext } from "./auth";
import { resolveUser, verifyMagicLink } from "./auth";
import type { Env } from "./env";
import { isoIn, sha256 } from "./lib/crypto";

interface Executed {
  sql: string;
  bindings: unknown[];
}

// Fake D1 that answers by SQL fragment and records every executed statement, so
// a test can assert how many round trips a flow costs — the point of batching.
function fakeEnv(answers: { match: string; first?: unknown }[]) {
  const executed: Executed[] = [];
  const batches: Executed[][] = [];
  const answerFor = (sql: string) => answers.find((answer) => sql.includes(answer.match));
  const env = {
    ADMIN_EMAILS: "boss@example.com",
    DB: {
      prepare(sql: string) {
        const statement = {
          sql,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            statement.bindings = bindings;
            return statement;
          },
          async first() {
            executed.push({ sql, bindings: statement.bindings });
            return answerFor(sql)?.first ?? null;
          },
          async run() {
            executed.push({ sql, bindings: statement.bindings });
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch(statements: { sql: string; bindings: unknown[] }[]) {
        batches.push(statements.map((s) => ({ sql: s.sql, bindings: s.bindings })));
        for (const statement of statements) executed.push({ sql: statement.sql, bindings: statement.bindings });
        return statements.map((statement) => ({
          results: answerFor(statement.sql)?.first ? [answerFor(statement.sql)!.first] : [],
          meta: { changes: 1 },
        }));
      },
    },
  } as unknown as Env;
  return { env, executed, batches };
}

// resolveUser reads a cookie, so exercise it through a request like production does.
async function callResolveUser(env: Env, cookie: string) {
  const app = new Hono<AppContext>();
  let resolved: unknown;
  app.get("/", async (c) => {
    resolved = await resolveUser(env, c);
    return c.json({ ok: true });
  });
  await app.request("/", { headers: { Cookie: cookie } });
  return resolved;
}

describe("resolveUser", () => {
  it("resolves the session and its user in a single query", async () => {
    const { env, executed } = fakeEnv([
      {
        match: "FROM session s JOIN user u",
        first: {
          id: 7,
          email: "reader@example.com",
          is_admin: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          session_expires_at: isoIn(60_000),
        },
      },
    ]);

    const user = await callResolveUser(env, "sr_session=tok");

    expect(user).toEqual({
      id: 7,
      email: "reader@example.com",
      is_admin: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(executed).toHaveLength(1);
  });

  it("rejects an expired session", async () => {
    const { env } = fakeEnv([
      {
        match: "FROM session s JOIN user u",
        first: { id: 7, email: "reader@example.com", session_expires_at: "2020-01-01T00:00:00.000Z" },
      },
    ]);

    expect(await callResolveUser(env, "sr_session=tok")).toBeNull();
  });

  it("skips the database entirely without a session cookie", async () => {
    const { env, executed } = fakeEnv([]);

    expect(await callResolveUser(env, "other=1")).toBeNull();
    expect(executed).toHaveLength(0);
  });
});

describe("verifyMagicLink", () => {
  it("burns the token and mints the session in one batch", async () => {
    const { env, executed, batches } = fakeEnv([
      {
        match: "FROM auth_token WHERE token_hash",
        first: { id: 3, email: "reader@example.com", expires_at: isoIn(60_000), used_at: null },
      },
    ]);

    const token = await verifyMagicLink(env, "magic");

    expect(token).toBeTruthy();
    // One lookup + one batch: the flow a person waits through after clicking.
    expect(batches).toHaveLength(1);
    expect(executed).toHaveLength(4);
    expect(batches[0].map((s) => s.sql.split("\n")[0].trim())).toEqual([
      "UPDATE auth_token SET used_at = ? WHERE id = ?",
      "INSERT INTO user (email) VALUES (?) ON CONFLICT(email) DO NOTHING",
      "INSERT INTO session (token_hash, user_id, expires_at)",
    ]);
    // The cookie value is never stored raw.
    expect(batches[0][2].bindings[0]).toBe(await sha256(token!));
  });

  it("grants admin inside the same batch for configured emails", async () => {
    const { env, batches } = fakeEnv([
      {
        match: "FROM auth_token WHERE token_hash",
        first: { id: 4, email: "boss@example.com", expires_at: isoIn(60_000), used_at: null },
      },
    ]);

    await verifyMagicLink(env, "magic");

    expect(batches[0].some((s) => s.sql.includes("SET is_admin = 1"))).toBe(true);
  });

  it("refuses a token that was already used", async () => {
    const { env, batches } = fakeEnv([
      {
        match: "FROM auth_token WHERE token_hash",
        first: {
          id: 5,
          email: "reader@example.com",
          expires_at: isoIn(60_000),
          used_at: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);

    expect(await verifyMagicLink(env, "magic")).toBeNull();
    expect(batches).toHaveLength(0);
  });
});
