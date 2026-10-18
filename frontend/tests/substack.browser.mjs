// Run with a Vite server and PLAYWRIGHT_MODULE pointing to Playwright if needed.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], calls = [];
let admin = false, followed = false;
page.on('pageerror', e => errors.push(e.message));
const connections = [
  { id: 'one', label: '共享账号', enabled: 1, status: 'active', expires_at: '2027-01-16T00:00:00Z', last_checked_at: '2026-10-18T20:00:00Z', last_error: null },
  { id: 'two', label: '另一个内容连接', enabled: 1, status: 'active', expires_at: null, last_checked_at: null, last_error: null },
  { id: 'expired', label: '失效连接', enabled: 1, status: 'needs_auth', expires_at: null, last_checked_at: null, last_error: 'Substack 登录已失效，请管理员重新连接' },
];
await page.route('**/api/**', async route => {
  const req = route.request(), u = new URL(req.url());
  if (u.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, email: 'qa@example.com', preferred_language: 'zh', is_admin: Number(admin) } } });
  if (u.pathname === '/api/sources/search') {
    calls.push({ path: u.pathname, provider: u.searchParams.get('provider'), platform: u.searchParams.get('platform') });
    return route.fulfill({ json: { results: u.searchParams.get('provider') === 'substack' ? [{ key: 'substack:84', provider: 'substack', provider_id: '84', kind: 'article', platform: 'substack', title: '免费搜索结果', url: 'https://free.substack.com', image_url: null, aliases: ['substack:84'], following: false, access: 'free' }] : [], next_offset: null } });
  }
  if (u.pathname === '/api/substack/connections') {
    if (req.method() === 'POST') { calls.push({ path: u.pathname, body: req.postDataJSON() }); return route.fulfill({ status: 201, json: { id: 'new' } }); }
    return route.fulfill({ json: connections });
  }
  if (u.pathname.endsWith('/subscriptions') && u.pathname.startsWith('/api/substack/')) return route.fulfill({ json: { sources: [{ id: followed ? 1 : null, title: u.pathname.includes('/two/') ? '另一刊物' : '示例刊物', url: 'https://example.substack.com', image_url: null, substack_publication_id: '42', access: 'free', following: followed }, { id: null, title: '付费刊物', url: 'https://paid.substack.com', image_url: null, substack_publication_id: '99', access: 'paid', following: false }], skipped: 0 } });
  if (u.pathname.endsWith('/follow') || u.pathname.endsWith('/import')) {
    calls.push({ path: u.pathname, body: req.postDataJSON() }); followed = true;
    return route.fulfill({ json: u.pathname.endsWith('/import') ? { imported: 1 } : { id: 1 } });
  }
  if (u.pathname.startsWith('/api/substack/connections/') && req.method() === 'PATCH') { calls.push({ path: u.pathname, body: req.postDataJSON() }); return route.fulfill({ json: { ok: true } }); }
  return route.fulfill({ json: [] });
});
await page.goto(`${process.env.FRONTEND_URL || 'http://127.0.0.1:5174'}/subscriptions?tab=substack`);
await page.getByText('示例刊物', { exact: true }).waitFor();
assert.equal(await page.getByRole('button', { name: '管理连接', exact: true }).count(), 0);
assert.equal(await page.getByRole('button', { name: '需要付费', exact: true }).isDisabled(), true);
await page.getByRole('button', { name: '关注', exact: true }).click();
await page.getByRole('button', { name: '已关注', exact: true }).waitFor();
assert(calls.some(c => c.body?.publication_id === '42'));
await page.getByRole('button', { name: '导入全部订阅' }).click();
await page.getByRole('status').filter({ hasText: '已关注 1 个' }).waitFor();
await page.getByRole('textbox', { name: 'Substack 刊物链接' }).fill('https://other.substack.com');
await page.getByRole('button', { name: '关注刊物', exact: true }).click();
await page.getByRole('status').filter({ hasText: '已关注 Substack 刊物' }).waitFor();
assert(calls.some(c => c.body?.url === 'https://other.substack.com'));
await page.getByRole('combobox', { name: 'Substack 内容连接' }).selectOption('two');
await page.getByText('另一刊物', { exact: true }).waitFor();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(350); // Existing shell's 300ms sidebar transition.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
if (process.env.SUBSTACK_SCREENSHOTS) await page.screenshot({ path: `${process.env.SUBSTACK_SCREENSHOTS}/substack-mobile.png`, fullPage: true });
await page.getByRole('combobox', { name: 'Substack 内容连接' }).selectOption('expired');
await page.getByText('此连接暂时不可用，已保存的文章仍可阅读。', { exact: true }).waitFor();
assert.equal(await page.getByRole('button', { name: '关注刊物', exact: true }).isDisabled(), true);
admin = true;
await page.reload();
await page.getByRole('button', { name: '管理连接', exact: true }).click();
await page.getByRole('textbox', { name: 'Substack 连接名称' }).fill('备用内容连接');
await page.getByLabel('Substack session cookie', { exact: true }).fill('substack.sid=synthetic-test-session');
await page.getByRole('button', { name: '验证并保存' }).click();
await page.getByRole('status').filter({ hasText: '连接已验证并保存' }).waitFor();
assert.equal(await page.getByLabel('Substack session cookie', { exact: true }).inputValue(), '');
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
await page.setViewportSize({ width: 1440, height: 1000 });
await page.getByRole('button', { name: '管理连接', exact: true }).click();
if (process.env.SUBSTACK_SCREENSHOTS) await page.screenshot({ path: `${process.env.SUBSTACK_SCREENSHOTS}/substack-desktop.png`, fullPage: true });
await page.getByRole('button', { name: '搜索免费刊物', exact: true }).click();
await page.getByRole('textbox', { name: '搜索来源', exact: true }).fill('technology');
await page.getByText('免费搜索结果', { exact: true }).waitFor();
assert(calls.some(c => c.provider === 'substack' && c.platform === 'substack'));
assert.equal(await page.getByRole('combobox', { name: '来源平台' }).inputValue(), 'substack');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(350);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
assert.deepEqual(errors, []);
console.log(JSON.stringify({ sharedAccountFollow: true, importSubscriptions: true, directUrl: true, switchConnections: true, expiredConnection: true, adminCredentialManagement: true, clearsCredentialInput: true, mobileOverflow: false, pageErrors: errors }));
await browser.close();
