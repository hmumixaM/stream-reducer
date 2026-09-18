import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { readBulletinTranslation, translateBulletinEdition, type BulletinTranslationRow } from "./bulletinTranslation";
const source = { id: 1, title: "Source title", headline: "Renting or owning AI", subhead: "The panel advocates a hybrid approach.", structured: JSON.stringify({ tldr: "The speakers favor a hybrid approach, citing costs and private data.", bulletin: [{text:"Use a hybrid approach.",timestamp:90}], walkthrough: "UNCHANGED ORIGINAL LONG NOTES" }) };
const chinese = { headline: "租用还是自建 AI", subhead: "嘉宾主张采用混合方式。", tldr: "嘉宾认为，应根据成本和私有数据需求，采用混合方式。" };
function setup(initial: Partial<BulletinTranslationRow> = {}, sourceOverride = source) {
  let row: BulletinTranslationRow = { status: "done", headline: "", subhead: "", tldr: "", bulletin: '[{"text":"采用混合方式。","timestamp":90}]', source_hash: "", updated_at: "2026-09-01", ...initial };
  const writes: {sql:string;values:unknown[]}[]=[];
  const env = {
    LLM_BASE_URL: "https://example.com/v1", LLM_MODEL: "configured", GEMINI_API_KEY: "test",
    DB: {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...args: unknown[]) { values = args; return this; },
          async first() { return sql.includes('JOIN summary') ? sourceOverride : row; },
          async run() {
            writes.push({sql, values});
            if (sql.includes('INSERT INTO')) row = {...row, status:'processing', source_hash:String(values[2]), updated_at:String(values[3])};
            if (sql.includes('SET headline=')) row = {...row, headline:String(values[0]), subhead:String(values[1]), tldr:String(values[2]), bulletin:String(values[3]), status:'done'};
            return {meta:{changes:1}};
          },
        };
      },
    },
  } as unknown as Env;
  return {env,writes,getRow:()=>row};
}
afterEach(()=>vi.unstubAllGlobals());
describe('complete Chinese bulletin',()=>{
  it('treats points-only historical rows as incomplete',()=>{
    expect(readBulletinTranslation(setup().getRow())).toMatchObject({status:'missing',complete:false,bulletin:[{text:'采用混合方式。',timestamp:90}]});
  });
  it('translates the intro while retaining existing Chinese points and the source summary',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(chinese)}}]})));
    vi.stubGlobal('fetch',fetch);
    const {env,writes,getRow}=setup();
    expect(await translateBulletinEdition(env,1)).toMatchObject({...chinese,status:'done',complete:true,bulletin:[{text:'采用混合方式。',timestamp:90}]});
    expect(writes.every(w=>!w.sql.includes('UPDATE summary'))).toBe(true);
    const request=JSON.parse(fetch.mock.calls[0][1].body);
    expect(request.messages[1].content).not.toContain('UNCHANGED ORIGINAL LONG NOTES');
    expect(request.response_format).toEqual({type:'json_object'});
    expect(readBulletinTranslation(getRow()).complete).toBe(true);
    await translateBulletinEdition(env,1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains original timestamps when translating points for the first time',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...chinese,bulletin:[{text:'混合方式。',timestamp:99999}]})}}]}))));
    expect((await translateBulletinEdition(setup({bulletin:'[]',status:'queued'}).env,1)).bulletin[0].timestamp).toBe(90);
  });
  it('rejects untranslated English overview output',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...chinese,tldr:'This is still English.'})}}]}))));
    await expect(translateBulletinEdition(setup().env,1)).rejects.toThrow('Incomplete Chinese');
  });
  it('uses existing Chinese points as evidence when an old summary has no overview',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(chinese)}}]})));
    vi.stubGlobal('fetch',fetch);
    const legacy={...source,structured:JSON.stringify({tldr:'',walkthrough:'Long original notes',key_points:[]})};
    const result=await translateBulletinEdition(setup({},legacy).env,1);
    expect(result.complete).toBe(true);
    const prompt=JSON.parse(fetch.mock.calls[0][1].body).messages[1].content;
    expect(prompt).toContain('采用混合方式。');
    expect(prompt).not.toContain('Long original notes');
  });
  it('uses original notes when a legacy summary has neither overview nor translated points',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...chinese,bulletin:[{text:'混合方式。',timestamp:999}]})}}]})));
    vi.stubGlobal('fetch',fetch);
    const legacy={...source,structured:JSON.stringify({walkthrough:'The speakers advocate a hybrid approach.'})};
    const result=await translateBulletinEdition(setup({status:'queued',bulletin:'[]'},legacy).env,1);
    expect(result.bulletin[0].timestamp).toBeNull();
    expect(JSON.parse(fetch.mock.calls[0][1].body).messages[1].content).toContain('The speakers advocate a hybrid approach.');
  });
});
