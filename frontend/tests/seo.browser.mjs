// FRONTEND_URL=http://127.0.0.1:5186 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node frontend/tests/seo.browser.mjs
// Real browser + production metadata hook. Public Worker HTML responses are fixtures;
// Worker/SQLite integration tests separately verify their eligibility and language policy.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
function metadata(path) {
  const url = new URL(path, base);
  const missing = url.searchParams.get('lang') === 'de';
  const lang = missing ? 'en' : url.searchParams.get('lang') || 'en';
  const canonical = 'https://reducer.xgoose.org' + url.pathname + (!missing && lang !== 'en' ? '?lang=' + lang : '');
  return `<html lang="${lang === 'zh' ? 'zh-CN' : lang}"><head><meta name="stream-reducer-seo" content="1"><title>${lang === 'zh' ? '中文会议与摘要' : lang === 'fr' ? 'Résumé français' : 'Conference summaries'}</title><meta name="robots" content="${missing ? 'noindex' : 'index'}, follow"><link rel="canonical" href="${canonical}"><link rel="alternate" hreflang="en" href="https://reducer.xgoose.org${url.pathname}"><link rel="alternate" hreflang="zh-Hans" href="https://reducer.xgoose.org${url.pathname}?lang=zh"><script id="seo-schema" type="application/ld+json">{"@type":"Article","url":"${canonical}"}</script></head><body></body></html>`;
}
try {
  await page.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/metadata-harness') return route.fulfill({ contentType: 'text/html', body: metadata('/items/1?lang=zh').replace('</body>', '<div id="test-root"></div></body>') });
    if (req.headers().accept === 'text/html' && /^\/(collections|items|rss\/articles)/.test(u.pathname)) return route.fulfill({ contentType: 'text/html', body: metadata(u.pathname + u.search) });
    return route.continue();
  });
  await page.goto(base + '/metadata-harness');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const seo = await import('/src/lib/seo.ts');
    const root = ReactDOM.createRoot(document.getElementById('test-root'));
    const Harness = ({ path, search }) => {
      seo.usePublicMetadata(path, search);
      seo.useArticleMetadata(1, 'Original English title', 'Original metadata that must not overwrite a public edition.');
      React.useEffect(() => { document.documentElement.dataset.metadataHarness = path + search; }, [path, search]);
      return null;
    };
    window.navigateMetadata = path => {
      history.pushState({}, '', path);
      const u = new URL(location.href);
      root.render(React.createElement(Harness, { path: u.pathname, search: u.search }));
    };
    window.navigateMetadata('/items/1?lang=zh');
  });
  await page.waitForFunction(() => document.documentElement.dataset.metadataHarness === '/items/1?lang=zh' && document.documentElement.lang === 'zh-CN' && document.querySelector('meta[name=stream-reducer-seo]'));
  await page.evaluate(async () => { const m = await import('/src/lib/seo.ts'); m.updateMetadata('Original English title', 'Original description', 'https://reducer.xgoose.org/items/1', true); });
  assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), 'https://reducer.xgoose.org/items/1?lang=zh');
  assert.equal(await page.locator('#seo-schema').count(), 1);
  for (const path of ['/collections', '/collections/conference?lang=zh', '/rss/articles/2?lang=fr', '/items/1?lang=de']) {
    await page.evaluate(path => window.navigateMetadata(path), path);
    await page.waitForFunction(path => document.documentElement.dataset.metadataHarness === path && !!document.querySelector('meta[name=stream-reducer-seo]'), path);
    const canonical = await page.locator('link[rel=canonical]').getAttribute('href');
    assert.equal(canonical, 'https://reducer.xgoose.org' + path.replace('?lang=de', ''));
    assert.equal(await page.locator('meta[name=robots]').getAttribute('content'), path.includes('lang=de') ? 'noindex, follow' : 'index, follow');
    assert.equal(await page.locator('#seo-schema').count(), 1);
  }
  await page.evaluate(() => window.navigateMetadata('/settings'));
  await page.waitForFunction(() => !document.querySelector('meta[name=stream-reducer-seo]'));
  assert.equal(await page.locator('meta[name=robots]').getAttribute('content'), 'noindex, follow');
  assert.equal(await page.locator('link[rel=alternate][hreflang]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('SEO browser: hydrated locale, legacy writers, client navigation, missing edition, private-page cleanup passed');
} finally { await browser.close(); }
