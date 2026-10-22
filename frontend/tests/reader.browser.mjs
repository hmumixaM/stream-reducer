// FRONTEND_URL=http://127.0.0.1:5186 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node frontend/tests/reader.browser.mjs
// All API traffic is mocked: no accounts, email, generation jobs or production writes.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.FRONTEND_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [];
const summary = { status: 'done', content: { lead: 'A concise reading of the evidence.', sections: [{ heading: 'Evidence before assumptions', body: 'Compare the evidence before drawing a conclusion. '.repeat(25), timestamp: 12 }, { heading: 'Keep a useful record', body: 'A useful record keeps claims close to their sources.', timestamp: null }], conclusion: 'Keep checking the source.' } };
const points = Array.from({ length: 8 }, (_, i) => ({ text: `Evidence point ${i + 1}`, timestamp: i * 20 }));
async function setup({ authed = false, preferred = 'auto', failed = false, blockedStorage = false, metadataFailed = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  if (blockedStorage) await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Blocked storage'); } }));
  const writes = [], requests = [];
  let fail = failed;
  const media = { id: 1, platform: 'youtube', title: 'How to read the evidence', source_url: 'https://example.com/video', author: 'Research notes', status: 'done', created_at: '2026-10-20', published_at: '2026-10-20', channel: { id: 1, title: 'Research notes' }, saved: false, duration_s: 80, view_count: 12345, like_count: 0, description: '<p>Original show notes &amp; references.</p>', total_tokens: 0, total_processing_ms: 0, total_cost_usd: 0, total_api_requests: 0, summary: { markdown: '## Full original notes\n\nA careful account of the original evidence.', structured: { tldr: 'An overview of the evidence.', bulletin: points, headline: 'How to read the evidence' } }, transcript: { source: 'native', language: 'en', text: 'Original transcript evidence for highlighting.', segments: [{ start: 0, end: 20, text: 'Original transcript evidence for highlighting.' }] }, stages: [], highlights: [], comments: [], translations: [{ lang: 'zh', status: 'done' }], localized_bulletin: { complete: true, status: 'done' }, infographic: null };
  const bulletin = { id: 1, title: media.title, source_title: media.title, source_url: media.source_url, author: media.author, platform: 'youtube', source_language: 'en', published_at: '2026-10-20', created_at: '2026-10-20', channel: media.channel, saved: false, bulletin_points: points, key_point_details: points, bulletin: points.map(p => p.text), bulletin_overview: 'An overview of the evidence.', bulletin_intro_ready: true, bulletin_language: 'original', localization_status: 'done', markdown: media.summary.markdown, walkthrough: media.summary.markdown, tldr: 'An overview of the evidence.', summary: 'An overview of the evidence.', background: 'A discussion with the original researchers.', quotes: [{ text: 'Follow the evidence.', speaker: 'Researcher', timestamp: 12 }], entities: [], content_translations: [{ lang: 'zh', status: 'done' }], reading_summary: summary, reading_summary_zh: summary, reading_summary_en: summary };
  const edition = { level: 'article', headline: 'An article about evidence', intro: 'The article introduces the evidence.', points: points.map(p => p.text), sections: [{ title: 'Article evidence', text: 'Read the original evidence carefully. '.repeat(50) }, { title: 'Article conclusion', text: 'The source remains available.' }], based_on_excerpt: false };
  const article = { id: 2, title: 'An article about evidence', url: 'https://example.com/article', author: 'Research notes', published_at: '2026-10-20', status: 'done', completeness: 'full', word_count: 800, sources: [], read: { saved: 0 }, editions: [{ lang: 'original', content: edition }, { lang: 'en', content: { ...edition, headline: 'English article edition' } }, { lang: 'zh', content: { ...edition, headline: '中文文章版本' } }] };
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    requests.push(path + url.search);
    if (request.method() !== 'GET') writes.push({ path, method: request.method(), data: request.postDataJSON() });
    if (path === '/api/auth/me') return route.fulfill({ json: { user: authed ? { id: 7, email: 'reader@example.com', preferred_language: preferred, is_admin: false } : null } });
    if (path === '/api/items/1') return metadataFailed ? route.fulfill({ status: 503, json: { error: 'Metadata unavailable' } }) : route.fulfill({ json: media });
    if (path === '/api/items/3') return route.fulfill({ json: { ...media, id: 3, status: 'transcribing', summary: null, transcript: null } });
    if (path === '/api/bulletin/1') { if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Temporary failure' } }); } return route.fulfill({ json: bulletin }); }
    if (path === '/api/items/1/translation') return route.fulfill({ json: { lang: 'zh', status: 'done', markdown: '## 中文完整笔记\n\n保留原始论述。', structured: { headline: '中文媒体版本', tldr: '中文概览', bulletin: ['中文要点'], walkthrough: '## 中文完整笔记\n\n保留原始论述。' } } });
    if (path === '/api/items/library') { bulletin.saved = true; media.saved = true; return route.fulfill({ json: [media] }); }
    if (path === '/api/items/1/highlights' && request.method() === 'POST') { const highlight = { ...request.postDataJSON(), id: media.highlights.length + 11, item_id: 1, note: null, created_at: '2026-10-20' }; media.highlights.push(highlight); return route.fulfill({ json: highlight }); }
    if (path === '/api/items/1/comments' && request.method() === 'POST') { const comment = { id: 12, body: request.postDataJSON().body, created_at: '2026-10-20' }; media.comments.push(comment); return route.fulfill({ json: comment }); }
    if (path === '/api/public/articles') return route.fulfill({ json: { articles: Array.from({ length: 24 }, (_, i) => ({ id: i + 2, title: i === 0 ? article.title : `Other article ${i}`, author: 'Research notes', published_at: '2026-10-20' })), has_more: true } });
    if (path === '/api/public/articles/2' || path === '/api/rss/articles/2') { if (request.method() === 'PATCH') article.read.saved = Number(request.postDataJSON().saved); return route.fulfill({ json: article }); }
    if (path.endsWith('/articles/2/body')) return route.fulfill({ json: { paragraphs: [{ id: 1, text: 'The saved original article remains accessible.' }], text: 'The saved original article remains accessible.', source_url: article.url, completeness: 'full' } });
    if (path === '/api/items') return route.fulfill({ json: [media] });
    return route.fulfill({ json: [] });
  });
  return { context, page, writes, requests };
}
try {
  const anon = await setup(); const p = anon.page;
  for (const path of ['/items/1', '/bulletin/1', '/rss/articles/2']) {
    await p.goto(base + path);
    await p.getByRole('tab', { name: 'Read', exact: true }).waitFor();
    assert.deepEqual(await p.getByRole('tab').allTextContents(), ['Overview', 'Read', 'Original & sources']);
    assert.equal(await p.locator('.content-reader-header h1').count(), 1);
    assert.equal(await p.getByText('Infographic', { exact: true }).count(), 0);
    if (!path.includes('/rss/')) {
      const info = p.getByRole('region', { name: 'Program information' });
      await info.getByText('1:20', { exact: true }).waitFor();
      assert.equal(await info.getByText('12K', { exact: true }).count(), 1);
      assert.equal(await info.getByText('0', { exact: true }).count(), 1);
      assert.equal(await info.getByRole('link', { name: 'Research notes', exact: true }).getAttribute('href'), '/channels/1');
      assert((await info.boundingBox()).y < (await p.getByRole('tablist').boundingBox()).y);
      await info.locator('summary').click();
      await info.getByText('Original show notes & references.', { exact: true }).waitFor();
      await info.getByText('0:20 (25%)', { exact: true }).waitFor();
      await info.getByText('Native captions', { exact: true }).waitFor();
      await p.setViewportSize({ width: 320, height: 844 });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'expanded program details overflow');
      await p.setViewportSize({ width: 1440, height: 1000 });
      await info.locator('summary').click();
    }
    await p.getByRole('tab', { name: 'Overview', exact: true }).click();
    assert.equal(await p.locator('.reader-overview li').count(), 5);
    await p.getByRole('button', { name: 'Show 3 more points' }).click();
    assert.equal(await p.locator('.reader-overview li').count(), 8);
    await p.reload();
    assert.equal(await p.getByRole('tab', { name: 'Overview', exact: true }).getAttribute('aria-selected'), 'true');
    await p.getByRole('tab', { name: 'Overview', exact: true }).focus(); await p.keyboard.press('ArrowRight');
    assert.equal(await p.getByRole('tab', { name: 'Read', exact: true }).getAttribute('aria-selected'), 'true');
    await p.getByRole('tab', { name: 'Original & sources' }).click();
    if (path.includes('/rss/')) await p.getByText('The saved original article remains accessible.', { exact: true }).waitFor();
    else await p.getByRole('heading', { name: 'Original transcript', exact: true }).waitFor();
    for (const width of [390, 320]) {
      await p.setViewportSize({ width, height: 844 });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${path} overflow at ${width}`);
    }
    await p.setViewportSize({ width: 1440, height: 1000 });
  }
  assert.deepEqual(anon.writes, []);
  const partial = await setup({ metadataFailed: true });
  await partial.page.goto(base + '/bulletin/1');
  await partial.page.getByText('Some program details could not load.', { exact: false }).waitFor();
  await partial.page.getByRole('tab', { name: 'Read', exact: true }).waitFor();
  assert.equal(await partial.page.getByRole('region', { name: 'Program information' }).getByRole('link', { name: 'Research notes', exact: true }).count(), 1);
  assert.deepEqual(partial.writes, []);
  await partial.context.close();
  await p.goto(base + '/bulletin/1?view=notes');
  await p.getByRole('heading', { name: 'Full original notes', exact: true }).waitFor();
  await p.getByRole('button', { name: '简体中文', exact: true }).click();
  await p.getByRole('heading', { name: '中文完整笔记', exact: true }).waitFor();
  assert.equal(new URL(p.url()).searchParams.get('lang'), 'zh');
  await p.reload(); await p.getByRole('heading', { name: '中文媒体版本', exact: true }).waitFor();
  await p.emulateMedia({ media: 'print' });
  assert.equal(await p.getByRole('region', { name: 'Keep what you discover' }).isVisible(), false);
  assert.equal(await p.locator('.reading-print h1').innerText(), '中文媒体版本');
  await p.emulateMedia({ media: 'screen' });
  await p.goto(base + '/articles?q=evidence&offset=24');
  const entry = p.getByRole('link', { name: 'An article about evidence', exact: true });
  await entry.waitFor();
  await p.evaluate(() => window.scrollTo(0, 450));
  await entry.click();
  await p.getByRole('tab', { name: 'Read', exact: true }).waitFor();
  assert.equal(new URL(p.url()).searchParams.get('from'), '/articles?q=evidence&offset=24');
  const returnY = await p.evaluate(() => history.state.usr.readerScrollY);
  await p.getByRole('tab', { name: 'Original & sources' }).click();
  await p.getByRole('link', { name: 'Back to list', exact: true }).click();
  await p.waitForURL(base + '/articles?q=evidence&offset=24');
  assert.equal(await p.getByRole('searchbox', { name: 'Search articles' }).inputValue(), 'evidence');
  await p.waitForFunction(y => Math.abs(window.scrollY - y) < 2, returnY);
  await p.goto(base + '/bulletin/1?from=%2F%2Fevil.example');
  await p.getByRole('tab', { name: 'Read', exact: true }).waitFor();
  assert.equal(await p.getByRole('link', { name: 'Back to list', exact: true }).getAttribute('href'), '/browse');
  await p.goto(base + '/items/3');
  await p.getByText('Processing… the summary will appear here.', { exact: true }).waitFor();
  assert.equal(await p.getByRole('tablist').count(), 0);
  await anon.context.close();

  const signed = await setup({ authed: true, preferred: 'en' }); const a = signed.page;
  await a.goto(base + '/rss/articles/2');
  await a.getByRole('heading', { name: 'English article edition', exact: true }).waitFor();
  assert.equal(await a.getByRole('combobox', { name: 'Translate to another language' }).count(), 0);
  assert.equal(await a.getByRole('button', { name: 'English', exact: true }).getAttribute('aria-pressed'), 'true');
  await a.getByRole('button', { name: 'Save article', exact: true }).click();
  await a.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  assert.equal(signed.requests.some(path => path.endsWith('/body')), false);
  await a.goto(base + '/items/1');
  await a.getByRole('button', { name: 'Save to library', exact: true }).click();
  await a.getByRole('button', { name: 'In library', exact: true }).waitFor();
  await a.getByRole('button', { name: 'Full notes', exact: true }).click();
  const notes = a.locator('[role=tabpanel] .reader-prose p').first();
  await notes.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await a.getByRole('button', { name: 'Highlight (yellow)', exact: true }).click();
  await a.getByRole('tab', { name: 'Original & sources' }).click();
  await a.getByRole('heading', { name: 'Original transcript', exact: true }).waitFor();
  const transcript = a.getByRole('heading', { name: 'Original transcript', exact: true }).locator('..').locator('.reader-prose p').first();
  await transcript.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await a.getByRole('button', { name: 'Highlight (yellow)', exact: true }).click();
  await a.getByRole('textbox', { name: 'Add a note or comment' }).fill('A useful reading note.');
  await a.getByRole('button', { name: 'Save note', exact: true }).click();
  await a.getByText('A useful reading note.', { exact: true }).waitFor();
  assert(signed.writes.some(write => write.path.endsWith('/highlights') && write.data.source === 'transcript'));
  assert(signed.writes.some(write => write.path.endsWith('/highlights') && write.data.source === 'summary'));
  await a.getByText('More', { exact: true }).click();
  await a.getByRole('link', { name: 'Notes & tools', exact: true }).click();
  await a.getByRole('link', { name: 'Back to reading', exact: true }).waitFor();
  assert.equal(await a.locator('.summary-paper').count(), 1);
  await a.getByRole('link', { name: 'Back to reading', exact: true }).click();
  await a.getByRole('tab', { name: 'Original & sources' }).waitFor();
  assert(signed.writes.some(write => write.path === '/api/items/library'));
  assert(signed.writes.some(write => write.path === '/api/rss/articles/2' && write.method === 'PATCH'));
  assert.equal(signed.writes.some(write => /translation|reading-summary|bulletin$/.test(write.path)), false);
  assert.equal(await a.getByRole('region', { name: 'Keep what you discover' }).count(), 0);
  await signed.context.close();

  const failure = await setup({ failed: true });
  await failure.page.goto(base + '/bulletin/1');
  await failure.page.getByRole('button', { name: /retry|try again/i }).click();
  await failure.page.getByRole('tab', { name: 'Read', exact: true }).waitFor();
  await failure.context.close();
  const blocked = await setup({ blockedStorage: true });
  await blocked.page.goto(base + '/items/1');
  await blocked.page.getByRole('button', { name: 'Keep browsing' }).click();
  await blocked.page.getByRole('tab', { name: 'Original & sources' }).click();
  await blocked.page.getByRole('heading', { name: 'Original transcript', exact: true }).waitFor();
  await blocked.context.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ sharedReader: true, legacyNotesLinks: true, allReadingLayersAccessible: true, urlStateAndLanguages: true, filteredReturn: true, anonymousReadOnly: true, authenticatedSaveHighlightAndNotes: true, englishArticlePreference: true, processingPagePreserved: true, mobile320And390: true, keyboardTabs: true, printUsesSelectedEdition: true, networkRetry: true, storageFailure: true, pageErrors: errors }, null, 2));
} finally { await browser.close(); }
