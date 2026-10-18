// Run against `npm --prefix frontend run dev` with Playwright installed.
// PLAYWRIGHT_MODULE may point to a bundled Playwright module; no API/server needed.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true,channel:"chrome"});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const requests=[], errors=[];
page.on('pageerror',e=>errors.push(e.message));
const row=(p,q)=>({key:p+':'+q,provider:p,provider_id:p,kind:p==='folo'?'article':'media',platform:p==='known'?'youtube':p==='folo'?'article':p,title:q+' '+p+' source',image_url:null,description:'公开来源简介，可以直接关注。',url:'https://example.com/'+p,feed_url:'https://example.com/feed/'+p,aliases:['feed:'+p],channel_id:p==='known'?1:null,rss_source_id:null,following:false});
await page.route('**/api/**', async route=>{
 const u=new URL(route.request().url());
 if(u.pathname==='/api/auth/me') return route.fulfill({json:{user:{id:1,email:'test@example.com',preferred_language:'zh',is_admin:0}}});
 if(u.pathname==='/api/sources/search'){
  const p=u.searchParams.get('provider'),q=u.searchParams.get('q');requests.push({p,q,t:Date.now()});
  await new Promise(r=>setTimeout(r,p==='known'?80:p==='bilibili'?600:p==='youtube'?1600:2100));
  if(q==='failure'&&p==='folo') return route.fulfill({status:502,json:{error:'Unavailable'}});
  return route.fulfill({json:{results:[row(p,q)],next_offset:null}}).catch(()=>{});
 }
 if(u.pathname==='/api/sources/follow'){
  const body=route.request().postDataJSON();
  return route.fulfill({json:{...row(body.provider,'Lex'),key:'media:7',channel_id:7,rss_source_id:null,following:true,aliases:['feed:'+body.provider]}});
 }
 return route.fulfill({json:[]});
});
await page.goto(`${process.env.FRONTEND_URL || 'http://127.0.0.1:5173'}/subscriptions?tab=discover&q=Lex`);
await page.getByText('Lex known source',{exact:true}).waitFor();
assert.equal(await page.getByText('Lex youtube source',{exact:true}).count(),0);
await page.getByText('Lex bilibili source',{exact:true}).waitFor();
assert.equal(await page.getByText('Lex youtube source',{exact:true}).count(),0);
await page.getByText('Lex folo source',{exact:true}).waitFor();
const titles=await page.locator('li .font-semibold').allTextContents();
assert.deepEqual(titles,['Lex known source','Lex bilibili source','Lex youtube source','Lex apple_podcast source','Lex folo source']);
await page.getByRole('button',{name:'关注',exact:true}).nth(1).click();
await page.getByRole('button',{name:'已关注',exact:true}).waitFor();
assert.deepEqual(await page.locator('li .font-semibold').allTextContents(),titles);
if (process.env.SOURCE_SCREENSHOTS) await page.screenshot({path:process.env.SOURCE_SCREENSHOTS+'/sources-desktop.png',fullPage:true});
await page.setViewportSize({width:390,height:844});
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
await page.waitForTimeout(350);
if (process.env.SOURCE_SCREENSHOTS) await page.screenshot({path:process.env.SOURCE_SCREENSHOTS+'/sources-mobile.png',fullPage:true});
const input=page.getByRole('textbox',{name:'搜索来源'});
await input.focus(); await page.keyboard.press('Tab');
assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SELECT');
await input.fill('old'); await page.waitForTimeout(400); await input.fill('new');
await page.getByText('new folo source',{exact:true}).waitFor();
assert.equal(await page.locator('li').filter({hasText:'old '}).count(),0);
await input.dispatchEvent('compositionstart'); await input.fill('中文组词'); await page.waitForTimeout(450);
assert.equal(requests.filter(r=>r.q==='中文组词').length,0);
await input.dispatchEvent('compositionend'); await page.getByText('中文组词 folo source',{exact:true}).waitFor();
await input.fill(''); await page.getByText(' known source',{exact:true}).waitFor();
const blank=requests.filter(r=>!r.q); assert(blank.every(r=>r.p==='known'));
await input.fill('failure'); await page.getByText('failure bilibili source',{exact:true}).waitFor();
await page.getByText('Folo 暂时不可用',{exact:true}).waitFor();
assert.equal(await page.getByText('没有找到匹配来源',{exact:true}).count(),0);
await page.getByRole('combobox',{name:'来源平台'}).selectOption('xiaoyuzhou');
await page.getByText('搜索 Folo 已收录的小宇宙节目，目录不覆盖全部节目。',{exact:true}).waitFor();
assert.equal(new URL(page.url()).searchParams.get('platform'),'xiaoyuzhou');
await page.reload(); await page.getByRole('textbox',{name:'搜索来源'}).waitFor(); assert.equal(await input.inputValue(),'failure');
assert.deepEqual(errors,[]);
console.log(JSON.stringify({progressiveLoading:true,stableAfterFollow:true,rapidQueryIsolation:true,ime:true,emptyNoExternal:true,partialFailure:true,urlRestore:true,mobileOverflow:false,requestCount:requests.length,pageErrors:errors},null,2));
await browser.close();
