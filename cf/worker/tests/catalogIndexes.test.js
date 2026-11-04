import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from './sqlite.mjs';

vi.mock('../src/auth', () => ({
  resolveUser: async () => ({ id: 1 }),
  requireAuth: async (c, next) => { c.set('user', { id: 1 }); await next(); },
}));
import { itemsRoutes } from '../src/routes/items';
import { queueRoutes } from '../src/routes/queue';

const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup() {
  const state = database(); databases.push(state.db);
  state.db.exec(`INSERT INTO user(id,email) VALUES(1,'one@example.com'),(2,'two@example.com');
    WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<7000)
    INSERT INTO item(id,source_url,status,published_at,created_at)
    SELECT id,'https://example.com/'||id,
      CASE WHEN id%101=0 THEN 'queued' WHEN id%13=0 THEN 'excluded' ELSE 'done' END,
      printf('2026-10-%02d',id%28+1),printf('2026-09-%02d',id%29+1) FROM ids;
    INSERT INTO user_item(user_id,item_id,added_at)
      SELECT CASE WHEN id%5=0 THEN 2 ELSE 1 END,id,printf('2026-10-%02d',id%28+1) FROM item;`);
  const queries = [];
  const prepare = state.DB.prepare.bind(state.DB);
  state.DB.prepare = sql => { queries.push(sql); return prepare(sql); };
  const app = new Hono().route('/api/items', itemsRoutes).route('/api/queue', queueRoutes);
  return { ...state, queries, request: path => app.request(path, {}, { DB: state.DB }) };
}

describe('indexed catalogue pages and active counts', () => {
  it('paginates public Browse by publication without a full sort and preserves personal state', async () => {
    const s = setup();
    const response = await s.request('/api/items?limit=24&offset=24');
    expect(response.status).toBe(200);
    const rows = await response.json();
    const expected = s.db.prepare("SELECT id FROM item WHERE status!='excluded' ORDER BY published_at DESC,created_at DESC LIMIT 24 OFFSET 24").all();
    expect(rows.map(r => r.id)).toEqual(expected.map(r => r.id));
    const sql = s.queries.find(q => q.includes('SELECT item.*'));
    const plan = s.db.prepare('EXPLAIN QUERY PLAN '+sql).all(1,1,24,24).map(r => r.detail).join('\n');
    expect(plan).toContain('ix_item_public_published');
    expect(plan).not.toContain('TEMP B-TREE');
    for (const row of rows) expect(row.saved).toBe(row.id%5!==0);
  });
  it('reads the latest personal saves in index order, including equal timestamps, with no sort', async () => {
    const s = setup();
    const response = await s.request('/api/items/library?limit=200');
    expect(response.status).toBe(200);
    const rows = await response.json();
    expect(rows).toHaveLength(200);
    expect(rows.every(r => r.id%5!==0)).toBe(true);
    const dates = rows.map(r => s.db.prepare('SELECT added_at FROM user_item WHERE user_id=1 AND item_id=?').get(r.id).added_at);
    expect(dates).toEqual([...dates].sort().reverse());
    const sql = s.queries.find(q => q.includes('SELECT item.*'));
    const plan = s.db.prepare('EXPLAIN QUERY PLAN '+sql).all(1,200,0).map(r => r.detail).join('\n');
    expect(plan).toContain('ix_user_item_added');
    expect(plan).not.toContain('TEMP B-TREE');
  });
  it('counts only active items owned by this user and follows item status changes', async () => {
    const s = setup();
    const expected = () => s.db.prepare("SELECT COUNT(*) n FROM user_item ui JOIN item i ON i.id=ui.item_id WHERE ui.user_id=1 AND i.status NOT IN ('done','excluded','error')").get().n;
    expect(await (await s.request('/api/queue/count')).json()).toEqual({active:expected()});
    const sql = s.queries.find(q => q.includes('SELECT COUNT(*)'));
    const plan = s.db.prepare('EXPLAIN QUERY PLAN '+sql).all(1).map(r => r.detail);
    expect(plan[0]).toContain('ix_item_active_id');
    expect(plan[1]).toContain('user_id=? AND item_id=?');
    s.db.exec("UPDATE item SET status='error' WHERE id=101; UPDATE item SET status='transcribing' WHERE id=1; UPDATE item SET status='queued' WHERE id=5;");
    expect(await (await s.request('/api/queue/count')).json()).toEqual({active:expected()});
  });
});
