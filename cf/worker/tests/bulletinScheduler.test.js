import { afterEach, describe, expect, it, vi } from 'vitest';
import { processNextBulletin } from '../src/lib/bulletinScheduler';
import { database } from './sqlite.mjs';

const databases=[];
const content={headline:'中文标题',subhead:'',tldr:'这是中文概览。',bulletin:[{text:'这是中文要点。',timestamp:12}]};
function setup() {
  const state=database(); databases.push(state.db);
  const calls=[];
  const fetch=vi.fn(async (_url, options)=>{
    calls.push(Number(JSON.parse(options.body).messages[1].content.match(/Source (\d+)/)[1]));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}));
  });
  vi.stubGlobal('fetch',fetch);
  return {...state, calls, fetch, env:{DB:state.DB,LLM_BASE_URL:'https://example.com',LLM_MODEL:'test',GEMINI_API_KEY:'test',BULLETIN_JOBS:{send:vi.fn().mockResolvedValue(undefined)}}};
}
afterEach(()=>{vi.unstubAllGlobals(); vi.restoreAllMocks(); for(const db of databases.splice(0))db.close();});
describe('durable newest-first bulletin processing',()=>{
  it('orders by publication date, breaks ties by id, and lets new arrivals precede older backlog',async()=>{
    const {item,env,calls}=setup();
    item(900,'2024-01-01'); item(2,'2026-09-18'); item(3,'2026-09-18');
    await processNextBulletin(env);
    item(1,'2026-09-19');
    for(let i=0;i<3;i++)await processNextBulletin(env);
    expect(calls).toEqual([3,1,2,900]);
  });
  it('concurrent workers never translate the same source twice',async()=>{
    const {item,env,calls,db}=setup();
    for(let i=1;i<=6;i++)item(i,'2026-09-18');
    await Promise.all(Array.from({length:6},()=>processNextBulletin(env)));
    expect([...calls].sort()).toEqual([1,2,3,4,5,6]);
    expect(db.prepare("SELECT count(*) n FROM bulletin_translation WHERE status='done'").get().n).toBe(6);
  });
  it('backs off failed sources, continues older work, and stops after three automatic attempts',async()=>{
    const {item,env,fetch,db}=setup(); item(2,'2026-09-18'); item(1,'2026-09-17');
    fetch.mockResolvedValue(new Response('unavailable',{status:503}));
    vi.spyOn(console,'error').mockImplementation(()=>{});
    await processNextBulletin(env);
    const failed=db.prepare('SELECT * FROM bulletin_translation WHERE item_id=2').get();
    expect(failed.status).toBe('error'); expect(failed.attempts).toBe(1);
    expect(Date.parse(failed.next_attempt_at)).toBeGreaterThan(Date.now());
    await processNextBulletin(env); // The failed newer item must not block the older one.
    expect(db.prepare('SELECT attempts FROM bulletin_translation WHERE item_id=1').get().attempts).toBe(1);
    for(let i=0;i<2;i++){
      db.exec("UPDATE bulletin_translation SET next_attempt_at='2000-01-01' WHERE item_id=2");
      await processNextBulletin(env);
    }
    await processNextBulletin(env);
    expect(db.prepare('SELECT attempts FROM bulletin_translation WHERE item_id=2').get().attempts).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(env.BULLETIN_JOBS.send).toHaveBeenLastCalledWith({kind:'bulletin_drain'},{delaySeconds:60});
  });
  it('recovers stale leases while respecting active leases and excluded content',async()=>{
    const {item,env,calls,db}=setup();
    item(3,'2026-09-18','processing'); item(2,'2026-09-17','processing'); item(4,'2026-09-19');
    db.exec("UPDATE bulletin_translation SET updated_at='2000-01-01',attempts=1 WHERE item_id=2; UPDATE item SET status='excluded' WHERE id=4;");
    await processNextBulletin(env);
    expect(calls).toEqual([2]);
    await processNextBulletin(env);
    expect(calls).toEqual([2]);
    expect(env.BULLETIN_JOBS.send).toHaveBeenLastCalledWith({kind:'bulletin_drain'},{delaySeconds:60});
  });
});
