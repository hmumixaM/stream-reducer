import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from './sqlite.mjs';
import { clearSession, resolveUser, verifyMagicLink } from '../src/auth';
import { sha256 } from '../src/lib/crypto';

vi.mock('@cloudflare/containers', () => ({ Container: class {}, getContainer: vi.fn() }));
import { adminRoutes } from '../src/routes/admin';

const databases = [];
function setup(options) {
  const state = database(options);
  databases.push(state.db);
  const env = { DB: state.DB };
  return { ...state, env };
}
async function magicLink(db, token, expires = '2099-01-01T00:00:00.000Z', used = null) {
  db.prepare("INSERT INTO auth_token(token_hash,email,purpose,expires_at,used_at) VALUES(?,'reader@example.com','magic_link',?,?)")
    .run(await sha256(token), expires, used);
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('last successful sign-in', () => {
  it('records first and subsequent sign-ins without changing the account creation date', async () => {
    const { db, env } = setup();
    await magicLink(db, 'first');
    const before = Date.now();
    expect(await verifyMagicLink(env, 'first')).toBeTruthy();
    const first = db.prepare('SELECT * FROM user').get();
    expect(Date.parse(first.last_login_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(first.last_login_at)).toBeLessThanOrEqual(Date.now());
    db.prepare('UPDATE user SET last_login_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', first.id);
    await magicLink(db, 'next');
    expect(await verifyMagicLink(env, 'next')).toBeTruthy();
    const next = db.prepare('SELECT * FROM user').get();
    expect(next.created_at).toBe(first.created_at);
    expect(Date.parse(next.last_login_at)).toBeGreaterThanOrEqual(before);
    expect(db.prepare('SELECT count(*) n FROM session').get().n).toBe(2);
  });

  it('ignores invalid, expired, and previously consumed magic links', async () => {
    const { db, env } = setup();
    const prior = '2026-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO user(email,last_login_at) VALUES(?,?)').run('reader@example.com', prior);
    await magicLink(db, 'expired', '2000-01-01T00:00:00.000Z');
    await magicLink(db, 'used', undefined, prior);
    for (const token of ['invalid', 'expired', 'used']) expect(await verifyMagicLink(env, token)).toBeNull();
    expect(db.prepare('SELECT last_login_at FROM user').get().last_login_at).toBe(prior);
    expect(db.prepare('SELECT count(*) n FROM session').get().n).toBe(0);
  });

  it('does not turn page visits into logins and retains the timestamp after logout', async () => {
    const { db, env } = setup();
    await magicLink(db, 'login');
    const session = await verifyMagicLink(env, 'login');
    const signedInAt = db.prepare('SELECT last_login_at FROM user').get().last_login_at;
    const app = new Hono();
    app.get('/me', async c => c.json(await resolveUser(env, c)));
    app.post('/logout', async c => { await clearSession(env, c); return c.json({ ok: true }); });
    const headers = { Cookie: `sr_session=${session}` };
    expect((await app.request('/me', { headers })).status).toBe(200);
    expect(db.prepare('SELECT last_login_at FROM user').get().last_login_at).toBe(signedInAt);
    await app.request('/logout', { method: 'POST', headers });
    expect(db.prepare('SELECT count(*) n FROM session').get().n).toBe(0);
    expect(db.prepare('SELECT last_login_at FROM user').get().last_login_at).toBe(signedInAt);
  });

  it('backfills the latest retained evidence and leaves unknown historical logins empty', () => {
    const { db } = setup({ beforeMigration: '0023_user_last_login.sql' });
    db.exec(`INSERT INTO user(id,email) VALUES(1,'one@example.com'),(2,'two@example.com'),(3,'unknown@example.com');
      INSERT INTO session(token_hash,user_id,created_at,expires_at) VALUES
        ('a',1,'2026-09-01T00:00:00.000Z','2026-10-01'),
        ('b',1,'2026-09-10T00:00:00.000Z','2026-10-01'),
        ('c',2,'2026-09-08T00:00:00.000Z','2026-10-01');
      INSERT INTO auth_token(token_hash,email,purpose,expires_at,used_at) VALUES
        ('d','one@example.com','magic_link','2026-10-01','2026-09-12T00:00:00.000Z'),
        ('e','two@example.com','magic_link','2026-10-01','2026-09-02T00:00:00.000Z'),
        ('f','unknown@example.com','magic_link','2026-10-01',NULL);`);
    db.exec(readFileSync(new URL('../migrations/0023_user_last_login.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT last_login_at FROM user ORDER BY id').all().map(row => row.last_login_at))
      .toEqual(['2026-09-12T00:00:00.000Z', '2026-09-08T00:00:00.000Z', null]);
  });

  it('exposes login timestamps only through the admin-guarded user list', async () => {
    const { db, env } = setup();
    db.exec("INSERT INTO user(id,email,is_admin,last_login_at) VALUES(1,'admin@example.com',1,'2026-09-19T01:00:00.000Z'),(2,'reader@example.com',0,NULL)");
    for (const [token, id] of [['admin', 1], ['reader', 2]]) {
      db.prepare('INSERT INTO session(token_hash,user_id,expires_at) VALUES(?,?,?)').run(await sha256(token), id, '2099-01-01T00:00:00.000Z');
    }
    const app = new Hono(); app.route('/admin', adminRoutes);
    expect((await app.request('/admin/users', {}, env)).status).toBe(401);
    expect((await app.request('/admin/users', { headers: { Cookie: 'sr_session=reader' } }, env)).status).toBe(403);
    const response = await app.request('/admin/users', { headers: { Cookie: 'sr_session=admin' } }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'admin@example.com', last_login_at: '2026-09-19T01:00:00.000Z' }),
      expect.objectContaining({ email: 'reader@example.com', last_login_at: null }),
    ]));
  });
});
