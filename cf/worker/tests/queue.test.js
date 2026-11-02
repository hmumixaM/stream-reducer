import { Hono } from 'hono';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from './sqlite.mjs';

const identity = vi.hoisted(() => ({ userId: 4 }));
vi.mock('../src/auth', () => ({ requireAuth: async (c, next) => {
  if (identity.userId == null) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', { id: identity.userId });
  await next();
} }));
import { queueRoutes } from '../src/routes/queue';

const databases = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
function setup() {
  const state = database();
  databases.push(state.db);
  identity.userId = 4;
  state.db.exec(`INSERT INTO user(id,email) VALUES(4,'one@example.com'),(5,'two@example.com');
    WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<6500)
    INSERT INTO item(id,source_url,status,priority_score,request_count,enqueued_at)
    SELECT id,'https://example.com/'||id,
      CASE WHEN id%17=0 THEN 'excluded' WHEN id%13=0 THEN 'done' WHEN id%11=0 THEN 'error' ELSE 'queued' END,
      id%23,id%5,'2026-11-01T00:00:00Z' FROM ids;
    INSERT INTO user_item(user_id,item_id) SELECT CASE WHEN id<=6454 THEN 4 ELSE 5 END,id FROM item;
    INSERT INTO stage_run(item_id,stage,status,chunk_done,chunk_count) VALUES(1,'download','done',0,0),(1,'transcribe','running',2,4);
    UPDATE item SET status='transcribing',started_at='2020-01-01T00:00:00Z' WHERE id=1;`);
  const app = new Hono();
  app.route('/api/queue', queueRoutes);
  return { ...state, request: path => app.request(path, {}, { DB: state.DB }) };
}

describe('large personal processing queues', () => {
  it('ranks thousands of saved items once, preserving global ties, ownership and stage progress', async () => {
    const { db, request } = setup();
    const global = db.prepare("SELECT id,priority_score,request_count,enqueued_at FROM item WHERE status NOT IN ('done','excluded') ORDER BY priority_score DESC,request_count DESC,enqueued_at ASC").all();
    const ranks = new Map();
    let rank = 0, previous = '';
    global.forEach((row, index) => {
      const key = JSON.stringify([row.priority_score, row.request_count, row.enqueued_at]);
      if (key !== previous) rank = index + 1;
      ranks.set(row.id, rank);
      previous = key;
    });
    const started = performance.now();
    const response = await request('/api/queue');
    const items = await response.json();
    expect(response.status).toBe(200);
    expect(items).toHaveLength(global.filter(row => row.id <= 6454).length);
    for (const item of items) {
      expect(item.queue_position).toBe(ranks.get(item.id));
      expect(item.queue_total).toBe(global.length);
      expect(item.id).toBeLessThanOrEqual(6454);
    }
    expect(items.find(item => item.id === 1)).toMatchObject({ current_stage: 'transcribe', chunk_done: 2, chunk_count: 4, stalled: true });
    // The former per-item global COUNT exceeded this budget on a 6,500-item backlog.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('returns only this user’s active count and excludes completed, gated and failed items', async () => {
    const { db, request } = setup();
    const expected = db.prepare("SELECT COUNT(*) n FROM item WHERE id<=6454 AND status NOT IN ('done','excluded','error')").get().n;
    expect(await (await request('/api/queue/count')).json()).toEqual({ active: expected });
    identity.userId = 99;
    expect(await (await request('/api/queue/count')).json()).toEqual({ active: 0 });
    identity.userId = null;
    expect((await request('/api/queue/count')).status).toBe(401);
    expect((await request('/api/queue')).status).toBe(401);
  });
});
