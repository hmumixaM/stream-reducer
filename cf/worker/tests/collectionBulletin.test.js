import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from './sqlite.mjs';
const {resolveUser}=vi.hoisted(()=>({resolveUser:vi.fn()}));
vi.mock('../src/auth',()=>({resolveUser,requireAuth:async(c,next)=>{c.set('user',{id:4,preferred_language:'zh'});await next();}}));
import { collectionRoutes } from '../src/routes/collections';
import { bulletinRoutes } from '../src/routes/bulletin';
const databases=[];
function setup(){
  const state=database(); databases.push(state.db);
  resolveUser.mockResolvedValue({id:4,preferred_language:'zh'});
  state.db.exec(`INSERT INTO user(id,email) VALUES(4,'test@example.com');
    INSERT INTO collection(id,slug,title,is_public) VALUES(1,'public','Public',1),(2,'private','Private',0);
    INSERT INTO collection_section(id,collection_id,slug,title) VALUES(1,1,'ai','AI'),(2,2,'secret','Secret');
    INSERT INTO collection_track(id,section_id,title) VALUES(1,1,'One'),(2,1,'Two'),(3,2,'Private');`);
  for(let id=1;id<=4;id++){
    state.item(id,id===4?'2026-09-19':'2026-09-18');
    state.db.prepare('INSERT INTO collection_item(collection_id,item_id) VALUES(?,?)').run(id===4?2:1,id);
    state.db.prepare('INSERT INTO collection_track_item(track_id,item_id) VALUES(?,?)').run(id===4?3:1,id);
  }
  state.db.exec(`INSERT INTO collection_track_item(track_id,item_id) VALUES(2,3);
    UPDATE item SET status='excluded' WHERE id=1;
    UPDATE bulletin_translation SET status='done',headline='中文标题',tldr='中文概览',bulletin='["中文要点"]';`);
  const app=new Hono();app.route('/api/collections',collectionRoutes);app.route('/api/bulletin',bulletinRoutes);
  return {...state,request:(path)=>app.request(path,{}, {DB:state.DB})};
}
afterEach(()=>{for(const db of databases.splice(0))db.close();});
describe('collection bulletin SQL and access',()=>{
  it('deduplicates tracks, excludes gated items, paginates stably and returns complete Chinese short editions',async()=>{
    const {request}=setup();
    const response=await request('/api/collections/public/bulletin?section=ai&limit=1');
    expect(response.status).toBe(200);
    const page=await response.json();
    expect(page.items.map(item=>item.id)).toEqual([3]);
    expect(page.items[0]).toMatchObject({title:'中文标题',bulletin_overview:'中文概览',bulletin:['中文要点']});
    expect(JSON.stringify(page)).not.toContain('LONG PRIVATE NOTES');
    const second=await (await request(`/api/collections/public/bulletin?section=ai&limit=1&cursor=${encodeURIComponent(page.next_cursor)}`)).json();
    expect(second.items.map(item=>item.id)).toEqual([2]);expect(second.next_cursor).toBeNull();
  });
  it('keeps filters inside their collection and never exposes a private collection',async()=>{
    const {request}=setup();
    expect((await request('/api/collections/private/bulletin')).status).toBe(404);
    expect((await (await request('/api/collections/public/bulletin?track_id=3')).json()).items).toEqual([]);
    expect((await (await request('/api/collections/public/bulletin?track_id=2')).json()).items.map(item=>item.id)).toEqual([3]);
    expect((await request('/api/collections/public/bulletin?cursor=broken')).status).toBe(400);
  });
  it('lets anonymous readers browse original bulletins and signed-in readers open public collection summaries without saving',async()=>{
    const {request}=setup();resolveUser.mockResolvedValue(null);
    const page=await (await request('/api/collections/public/bulletin')).json();
    expect(page.items[0].title).toBe('Source 3');
    expect((await request('/api/bulletin/3')).status).toBe(200);
    expect((await request('/api/bulletin/4')).status).toBe(404);
    expect((await request('/api/bulletin/1')).status).toBe(404);
  });
});
