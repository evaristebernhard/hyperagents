import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

let server, browser, page, base;
before(async () => {
  server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
    plugins: [{ name: 'isolated-preview-test', configureServer(vite) {
      vite.middlewares.use('/preview-regression', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>preview test</title><body></body>'); });
    } }],
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  base = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(5000);
  await page.goto(base + '/preview-regression');
  assert.equal(await page.locator('#root').count(), 0, 'Tests must not load the real workspace');
  await page.evaluate(async () => { window.previewModule = await import('/src/webpage-preview.ts'); });
});
after(async () => { await browser?.close(); await server?.close(); });
async function render(html, width=800) {
  await page.evaluate(({html,width}) => {
    document.querySelector('iframe')?.remove();
    const iframe = document.createElement('iframe'); iframe.title = 'regression';
    iframe.setAttribute('sandbox', ''); iframe.style.width = width + 'px'; iframe.style.height = '300px';
    iframe.srcdoc = window.previewModule.buildWebpagePreview(html); document.body.append(iframe);
  }, {html,width});
  const handle = await page.locator('iframe').elementHandle();
  const frame = await handle.contentFrame();
  await frame.waitForURL('about:srcdoc');
  await frame.waitForSelector('body');
  return frame;
}
const fixture = `<!doctype html><html><head><style>
body{margin:0;background:#0a0e17;color:#e8edf7}.projects{display:grid;grid-template-columns:repeat(3,1fr)}
.project{color:#3b82f6}.project:hover{color:rgb(255,0,0)}section{margin-top:500px}
@media(max-width:420px){.projects{grid-template-columns:1fr}}
</style></head><body><a href="#projects">项目</a><a href="mailto:hello@example.com">邮件</a>
<section id="projects" class="projects"><article class="project">网页作品集</article><article class="project">数据看板</article><article class="project">自动化助手</article></section></body></html>`;

test('complete document preserves head CSS, colors and three project cards', async () => {
  const frame = await render(fixture);
  assert.equal(await frame.locator('style').count(), 1);
  assert.equal(await frame.locator('article.project').count(), 3);
  assert.equal(await frame.locator('body').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(10, 14, 23)');
  assert.equal(await frame.locator('article').first().evaluate(e => getComputedStyle(e).color), 'rgb(59, 130, 246)');
});
test('fragment navigation works inside opaque iframe without top navigation', async () => {
  const frame = await render(fixture); const parent = page.url();
  assert.equal(await frame.locator('a').first().getAttribute('href'), 'about:srcdoc#projects');
  assert.equal(await frame.locator('a').nth(1).getAttribute('href'), 'mailto:hello@example.com');
  await frame.getByText('项目', {exact:true}).click();
  assert.ok(await frame.evaluate(() => scrollY) > 0);
  assert.equal(page.url(), parent);
});
test('responsive media query and hover CSS survive sanitization', async () => {
  const frame = await render(fixture, 390);
  const columns = await frame.locator('.projects').evaluate(e => getComputedStyle(e).gridTemplateColumns);
  assert.equal(columns.split(' ').length, 1);
  await frame.locator('article').first().hover();
  assert.equal(await frame.locator('article').first().evaluate(e => getComputedStyle(e).color), 'rgb(255, 0, 0)');
});
test('scripts, event handlers, frames, forms and dangerous links remain blocked', async () => {
  const frame = await render(`<html><head><base href="https://blocked-preview.invalid/"><meta http-equiv="refresh" content="0;url=https://blocked-preview.invalid/"></head><body onload="window.unsafe=1"><script>window.unsafe=1</script><iframe srcdoc="bad"></iframe><form action="https://blocked-preview.invalid/"><input></form><a href="javascript:alert(1)" onclick="window.unsafe=1">bad</a><a href="https://blocked-preview.invalid/" target="_top">external</a><a href="//blocked-preview.invalid/">protocol</a><a href="mailto:test@example.com?body=bad">headers</a><div style="color:blue">safe style</div></body></html>`);
  assert.equal(await frame.locator('script,iframe,form,base,link,[onload],[onclick],a[href]').count(), 0);
  assert.equal(await frame.evaluate(() => window.unsafe), undefined);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), '');
  assert.equal(await frame.locator('div').evaluate(e => getComputedStyle(e).color), 'rgb(0, 0, 255)');
});
test('iframe CSP blocks CSS imports, escaped URLs and resource loads without network requests', async () => {
  const dispatched = [], failures = [];
  const onFailed = req => { if(req.url().includes('blocked-preview.invalid')) failures.push(req.failure()?.errorText || ''); };
  // Chromium emits request events even for CSP-blocked attempts. Routing sees
  // actual network dispatch; abort defensively if the policy regresses.
  const route = async intercepted => { dispatched.push(intercepted.request().url()); await intercepted.abort(); };
  await page.route('https://blocked-preview.invalid/**', route);
  page.on('requestfailed', onFailed);
  try {
    const frame = await render(`<html><head><style>@import 'https://blocked-preview.invalid/import.css';body{background-image:url(https://blocked-preview.invalid/bg)}p{background-image:u\\72l('https://blocked-preview.invalid/escaped')}</style><link rel="stylesheet" href="https://blocked-preview.invalid/a.css"></head><body><img src="https://blocked-preview.invalid/x"><p style="background:url(https://blocked-preview.invalid/inline)">isolated</p></body></html>`);
    await frame.getByText('isolated').waitFor();
    // Resource requests are scheduled by document load; animation frames can be
    // throttled indefinitely for offscreen iframes in headless Chromium.
    await frame.waitForLoadState('load', {timeout:5000});
    assert.deepEqual(dispatched, []);
    assert.ok(failures.length > 0, 'Expect CSP-blocked attempts');
    assert.ok(failures.every(error => error === 'csp' || error.includes('ERR_BLOCKED_BY_CSP')), JSON.stringify(failures));
    const policy = await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(policy, /default-src 'none'/); assert.match(policy, /script-src 'none'/);
  } finally { page.off('requestfailed', onFailed); await page.unroute('https://blocked-preview.invalid/**', route); }
});
