// Isolated BrowserSessionPanel -> actual HTTP -> fresh broker -> real local browser.
// No production service, existing CDP endpoint, saved account, or external site is used.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { startBrowserBroker } from '../../server/browser-broker.mjs';
import { launchPersistentBrowser } from '../../server/persistent-browser-driver.mjs';

const { chromium, expect } = createRequire(new URL('../../package.json', import.meta.url))('@playwright/test');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/verification-browser-takeover-input');
const directory = await mkdtemp(path.join(tmpdir(), 'hyperagents-takeover-input-'));
const token = randomBytes(32).toString('base64url'), owner = 'isolated:takeover-input';
const checks = [], http = [], errors = [];
const report = {
  startedAt: new Date().toISOString(),
  scope: 'Standalone real BrowserSessionPanel, actual HTTP proxy, disposable persistent broker and fresh local Chromium target. No production data, existing profile, external URL, or existing CDP endpoint.',
  sourceFiles: ['src/browser/BrowserSessionPanel.tsx', 'src/browser/browser-session.css', '../server/browser-broker.mjs', '../server/persistent-browser-driver.mjs'],
  command: 'node scripts/verify-browser-takeover-input.mjs', checks, http, browserErrors: errors, screenshots: [],
};
let target, broker, vite, browser, page, driver, moli, moliBrowser;
let brokerURL, baseURL, fixtureOrigin, sessionId;
const check = (name, detail) => checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const waitUntil = async (predicate, milliseconds = 10000) => {
  const end = Date.now() + milliseconds;
  do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 75)); } while (Date.now() < end);
  throw new Error('Isolated service did not become ready');
};
const stopMoli = async () => {
  await moliBrowser?.close().catch(() => {}); moliBrowser = undefined;
  if (moli && moli.exitCode === null) {
    moli.kill('SIGTERM');
    await Promise.race([new Promise(resolve => moli.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
    if (moli.exitCode === null) moli.kill('SIGKILL');
  }
};
const brokerJson = async (suffix, body, actor = 'human', runId) => {
  const response = await fetch(brokerURL + suffix, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Browser-Owner': owner, 'X-Browser-Actor': actor, ...(runId ? { 'X-Browser-Run': runId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify({ status: response.status, result })); return result;
};
const readFixture = async () => {
  const match = (await driver.observe()).text.match(/STATE:(\{[^\n]+\})/);
  assert.ok(match, 'the real remote browser must expose its local fixture state'); return JSON.parse(match[1]);
};
const waitFrame = async () => {
  await expect(page.locator('.pb-screen img')).toBeVisible();
  await expect.poll(() => page.locator('.pb-screen img').evaluate(image => image.complete && image.naturalWidth === 1280 && image.naturalHeight === 800)).toBe(true);
};
const waitInteractive = async () => {
  await waitFrame(); await expect(page.locator('.pb-screen')).toHaveAttribute('data-click-ready', 'true');
};
const remoteClick = async (x, y) => {
  await waitInteractive(); await page.locator('.pb-screen').scrollIntoViewIfNeeded();
  const rect = await page.locator('.pb-screen img').boundingBox();
  assert.ok(rect?.width && rect?.height, 'decoded screenshot must have real geometry');
  await page.mouse.click(rect.x + x / 1280 * rect.width, rect.y + y / 800 * rect.height);
};
const assertRemotePoint = async (x, y) => {
  const actual = (await readFixture()).lastClick;
  // Browser pointer dispatch rounds CSS pixels before the screenshot scaling;
  // one remote pixel is the expected upper bound at these tested zoom levels.
  assert.ok(Math.abs(actual.x - x) <= 1 && Math.abs(actual.y - y) <= 1, JSON.stringify({ expected: { x, y }, actual }));
  return actual;
};
const screenshot = async name => {
  await page.screenshot({ path: path.join(output, name), fullPage: true }); report.screenshots.push(name);
};
const assertGeometry = async label => {
  const sizes = await page.evaluate(() => {
    const screen = document.querySelector('.pb-screen').getBoundingClientRect();
    const image = document.querySelector('.pb-screen img').getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, screen: { width: screen.width, height: screen.height }, image: { width: image.width, height: image.height }, pageWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth };
  });
  assert.ok(sizes.screen.width <= 762, JSON.stringify(sizes));
  assert.ok(sizes.screen.height <= Math.min(402, sizes.viewport.height * .45 + 2), JSON.stringify(sizes));
  assert.ok(Math.abs(sizes.image.width / sizes.image.height - 1.6) < .01, JSON.stringify(sizes));
  assert.ok(sizes.pageWidth <= sizes.viewport.width + 1 && sizes.bodyWidth <= sizes.viewport.width + 1, JSON.stringify(sizes));
  check(label, sizes);
};
const assertSticky = async () => {
  await page.locator('.pb-screen').evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + scrollY - 170));
  const controls = await page.evaluate(() => {
    const result = {};
    for (const name of ['pb-control-bar', 'pb-text-form', 'pb-keys']) {
      const element = document.querySelector('.' + name), rect = element.getBoundingClientRect();
      let parent = element, sticky = false;
      while (parent && parent !== document.body) { if (getComputedStyle(parent).position === 'sticky') sticky = true; parent = parent.parentElement; }
      result[name] = { top: rect.top, bottom: rect.bottom, sticky, height: innerHeight };
    }
    return result;
  });
  assert.equal(controls['pb-control-bar'].sticky, true, JSON.stringify(controls));
  for (const value of Object.values(controls)) assert.ok(value.top >= -1 && value.bottom <= value.height, JSON.stringify(controls));
  check('sticky takeover button, text field, and remote keyboard remain visible with the screenshot', controls);
};

try {
  await mkdir(output, { recursive: true });
  target = createHttpServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>隔离输入验收</title><style>body{margin:0;background:#f4f6fa;color:#25324b;font:22px sans-serif;height:1800px}h1{position:absolute;left:40px;top:5px;font-size:25px}button,input{position:absolute;left:40px;box-sizing:border-box;font:22px sans-serif}#count{top:85px;width:180px;height:50px}#entry{top:170px;width:520px;height:48px;padding:7px}#state{position:absolute;left:40px;top:270px;font:15px monospace;white-space:pre-wrap}</style><h1>临时本地浏览器输入验收</h1><button id="count">点击计数</button><input id="entry" aria-label="隔离目标输入" autocomplete="off"><output id="state"></output><script>let clicks=0,lastClick=null;const keys=[],entry=document.querySelector('#entry'),out=document.querySelector('#state');function update(){out.textContent='STATE:'+JSON.stringify({clicks,text:entry.value,lastClick,keys,focus:document.activeElement.id})}document.querySelector('#count').onclick=()=>{clicks++;update()};document.addEventListener('click',event=>{lastClick={x:Math.round(event.clientX),y:Math.round(event.clientY)};update()});entry.addEventListener('input',update);entry.addEventListener('keydown',event=>{keys.push(event.key);update()});update();</script></html>`);
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  fixtureOrigin = `http://127.0.0.1:${target.address().port}`;
  broker = await startBrowserBroker({ dataDir: path.join(directory, 'broker'), token, port: 0, trustedOrigins: [fixtureOrigin], driverFactory: async options => {
    driver = await launchPersistentBrowser({ ...options, proxy: '' }); return driver;
  } });
  brokerURL = `http://127.0.0.1:${broker.port}`;
  const initial = (await brokerJson('/sessions', { url: fixtureOrigin + '/isolated' })).session;
  sessionId = initial.id; assert.equal(initial.control, 'agent');
  const uiPort = await freePort(); baseURL = `http://127.0.0.1:${uiPort}`;
  const harness = {
    name: 'isolated-takeover-harness',
    resolveId(id) { if (id === '/__takeover-harness.jsx') return id; },
    load(id) {
      if (id === '/__takeover-harness.jsx') return `import React from 'react';import{createRoot}from'react-dom/client';import BrowserSessionPanel from '/src/browser/BrowserSessionPanel.tsx';createRoot(document.getElementById('root')).render(<main><div style={{height:80}}>隔离浏览器 UI 验收</div><BrowserSessionPanel workspaceId="isolated-input-verification"/><div style={{height:700}}>页面底部</div></main>);`;
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, baseURL);
        if (url.pathname === '/') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离接管验收</title><style>body{margin:0;background:#f2f4f7;font:14px sans-serif}main{padding:24px;background:white}</style><div id="root"></div><script type="module" src="/__takeover-harness.jsx"></script></html>')); return;
        }
        if (!url.pathname.startsWith('/api/agent/browser/')) return next();
        if (url.pathname === '/api/agent/browser/capabilities') {
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ configured: true, available: true, persistent: true })); return;
        }
        try {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks), suffix = url.pathname.slice('/api/agent/browser'.length);
          const payload = body.length ? JSON.parse(body.toString()) : undefined;
          const record = { method: request.method, path: suffix, ...(payload ? { body: payload } : {}) }; http.push(record);
          const upstream = await fetch(brokerURL + suffix, { method: request.method, headers: { Authorization: `Bearer ${token}`, 'X-Browser-Owner': owner, 'X-Browser-Actor': 'human', ...(body.length ? { 'Content-Type': 'application/json' } : {}) }, ...(body.length ? { body } : {}) });
          record.status = upstream.status;
          response.statusCode = upstream.status;
          for (const [key, value] of upstream.headers) if (!['connection', 'transfer-encoding', 'content-encoding'].includes(key)) response.setHeader(key, value);
          response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) { response.statusCode = 503; response.end(JSON.stringify({ error: error.message })); }
      });
    },
  };
  vite = await createServer({ root, configFile: false, envFile: false, plugins: [harness, react()], optimizeDeps: { entries: [], include: ['react', 'react-dom/client'], esbuildOptions: { target: 'es2022' } }, server: { host: '127.0.0.1', port: uiPort, strictPort: true, watch: null } });
  await vite.listen();

  // Moli is attempted first on a private, dynamically selected endpoint. The
  // production target driver is independently Chromium by implementation.
  const moliPort = await freePort(), moliLog = [];
  const version = spawnSync('moli', ['--version'], { encoding: 'utf8' });
  report.moli = { version: version.stdout?.trim() || version.error?.message, log: moliLog };
  try {
    if (version.status !== 0) throw new Error(report.moli.version || 'Moli unavailable');
    moli = spawn('moli', ['serve', '--host', '127.0.0.1', '--port', String(moliPort), '--layout', '--resource', '--profile-dir', path.join(directory, 'moli-profile')], { stdio: ['ignore', 'pipe', 'pipe'] });
    moli.stdout.on('data', data => moliLog.push(data.toString())); moli.stderr.on('data', data => moliLog.push(data.toString()));
    await waitUntil(async () => { try { return (await fetch(`http://127.0.0.1:${moliPort}/json/version`)).ok; } catch { return false; } });
    moliBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${moliPort}`);
    const moliPage = await moliBrowser.contexts()[0].newPage(); moliPage.setDefaultTimeout(7000);
    await moliPage.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await expect(moliPage.locator('.pb-screen')).toBeVisible();
    await expect.poll(() => moliPage.locator('.pb-screen img').count(), { timeout: 6000 }).toBe(1);
    const geometry = await moliPage.locator('.pb-screen img').evaluate(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, naturalWidth: image.naturalWidth, complete: image.complete }));
    report.moli.geometry = geometry;
    assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.naturalWidth === 1280 && geometry.complete, 'Moli cannot render the decoded Blob screenshot geometry required for input coordinates');
    throw new Error('Moli rendered the probe; this regression currently requires Chromium native IME composition commands');
  } catch (error) {
    report.moli.failure = error.message;
    report.moli.fallback = 'Fresh isolated headless Chromium is required for Blob screenshot geometry, native CDP IME composition, and native clipboard paste. No existing user CDP browser is accessed.';
  } finally { await stopMoli(); }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL); await waitFrame();
  await expect(page.locator('.pb-state')).toHaveText('AI 控制');
  await expect(page.getByRole('button', { name: '点击开始操作', exact: true })).toBeVisible();
  await screenshot('takeover-agent-overlay.png');
  const takeoverStart = http.length;
  await page.getByRole('button', { name: '点击开始操作', exact: true }).click();
  await expect(page.locator('.pb-state')).toHaveText('你正在接管'); await waitInteractive();
  const firstTakeover = http.slice(takeoverStart).filter(item => item.path.endsWith('/takeover'));
  assert.equal(firstTakeover.length, 1); assert.equal(firstTakeover[0].method, 'POST'); assert.equal(firstTakeover[0].status, 200);
  assert.equal(firstTakeover[0].body.expectedEpoch, initial.epoch); assert.ok(firstTakeover[0].body.requestId);
  assert.equal(http.slice(takeoverStart).filter(item => item.body?.type === 'click').length, 0);
  assert.equal((await readFixture()).clicks, 0);
  check('agent overlay performs genuine HTTP takeover exactly once and does not forward its activation click');

  await assertGeometry('desktop screenshot stays within the compact viewport'); await assertSticky();
  await remoteClick(110, 110); await expect.poll(async () => (await readFixture()).clicks).toBe(1);
  check('fit screenshot maps the real pointer coordinates to the actual remote target', await assertRemotePoint(110, 110));
  await remoteClick(150, 194);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await expect.poll(async () => (await readFixture()).focus).toBe('entry');
  const directStart = http.length;
  await page.keyboard.type('quickASCII123abc', { delay: 0 });
  await page.keyboard.press('Backspace'); await page.keyboard.press('ArrowLeft'); await page.keyboard.type('Z'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  const ascii = 'quickASCII123aZb';
  await expect.poll(async () => (await readFixture()).text).toBe(ascii);
  const direct = http.slice(directStart).filter(item => item.body?.type === 'text' || item.body?.type === 'key');
  assert.deepEqual(direct.filter(item => item.body.type === 'key').map(item => item.body.key), ['Backspace', 'ArrowLeft', 'End', 'Enter']);
  assert.ok(direct.every(item => item.status === 200), JSON.stringify(direct));
  check('rapid direct ASCII and navigation keys arrive in order with no dropped or duplicate text', { text: ascii, requests: direct.length });

  // Native Chromium composition creates the real compositionstart/input/
  // compositionend sequence rather than invoking the component's callbacks.
  await page.evaluate(() => {
    window.__takeoverInputEvents = [];
    const input = document.activeElement;
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'paste']) input.addEventListener(type, event => window.__takeoverInputEvents.push({ type: event.type, inputType: event.inputType, data: event.data, isComposing: event.isComposing, isTrusted: event.isTrusted }));
  });
  const imeStart = http.length, cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中文组合', selectionStart: 4, selectionEnd: 4 });
  await cdp.send('Input.insertText', { text: '中文组合' });
  await expect.poll(async () => (await readFixture()).text).toBe(ascii + '中文组合');
  const ime = http.slice(imeStart).filter(item => item.body?.type === 'text');
  assert.equal(ime.length, 1); assert.equal(ime[0].body.text, '中文组合'); assert.equal(ime[0].status, 200);
  const nativeEvents = await page.evaluate(() => window.__takeoverInputEvents);
  assert.ok(nativeEvents.some(event => event.type === 'compositionend'), JSON.stringify(nativeEvents));
  check('native IME compositionend sends composed Chinese exactly once', nativeEvents);

  // Some platform IMEs follow compositionend with the same committed input.
  // Add that final InputEvent explicitly, then a real ASCII sentinel so the
  // ordered HTTP queue has completed before asserting there was no duplicate.
  const finalInputStart = http.length;
  await page.evaluate(() => {
    const input = document.activeElement; input.value = '中文组合';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文组合', isComposing: false }));
  });
  await page.keyboard.type('!');
  await expect.poll(async () => (await readFixture()).text).toBe(ascii + '中文组合!');
  const finalInput = http.slice(finalInputStart).filter(item => item.body?.type === 'text');
  assert.deepEqual(finalInput.map(item => item.body.text), ['!']);
  check('trailing duplicate IME InputEvent is suppressed and subsequent ordinary ASCII still arrives');

  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await page.evaluate(() => navigator.clipboard.writeText('粘贴一次✓'));
  const pasteStart = http.length; await page.keyboard.press('Control+V');
  await expect.poll(async () => (await readFixture()).text).toBe(ascii + '中文组合!粘贴一次✓');
  const paste = http.slice(pasteStart).filter(item => item.body?.type === 'text');
  assert.equal(paste.length, 1); assert.equal(paste[0].body.text, '粘贴一次✓'); assert.equal(paste[0].status, 200);
  assert.ok((await page.evaluate(() => window.__takeoverInputEvents)).some(event => event.type === 'paste'));
  check('native clipboard paste reaches the real target exactly once');
  await cdp.detach();

  await page.getByLabel('画面缩放', { exact: true }).selectOption('1.5');
  await remoteClick(110, 110); await expect.poll(async () => (await readFixture()).clicks).toBe(2);
  check('150 percent zoom retains real remote coordinate mapping', await assertRemotePoint(110, 110));
  await page.getByLabel('画面缩放', { exact: true }).selectOption('fit');
  await screenshot('takeover-desktop.png');

  await page.getByRole('button', { name: '交还 AI', exact: true }).click();
  await expect(page.locator('.pb-state')).toHaveText('AI 控制');
  const runId = 'isolated-input-' + randomUUID();
  const bound = (await brokerJson('/sessions', {}, 'agent', runId)).session;
  const paused = (await brokerJson(`/sessions/${sessionId}/request-takeover`, { expectedEpoch: bound.epoch, requestId: randomUUID() }, 'agent', runId)).session;
  assert.equal(paused.control, 'paused');
  await expect(page.locator('.pb-state')).toHaveText('已暂停'); await waitFrame();
  const pausedStart = http.length, previous = await readFixture();
  await page.getByRole('button', { name: '点击开始操作', exact: true }).click();
  await expect(page.locator('.pb-state')).toHaveText('你正在接管'); await waitInteractive();
  const pausedTakeover = http.slice(pausedStart).filter(item => item.path.endsWith('/takeover'));
  assert.equal(pausedTakeover.length, 1); assert.equal(pausedTakeover[0].status, 200); assert.equal(pausedTakeover[0].body.expectedEpoch, paused.epoch);
  assert.equal(http.slice(pausedStart).filter(item => item.body?.type === 'click').length, 0);
  assert.equal((await readFixture()).clicks, previous.clicks); assert.equal((await readFixture()).text, previous.text);
  check('genuine broker paused state overlay takes over over HTTP and does not pass the click through');

  await page.setViewportSize({ width: 390, height: 844 });
  await assertGeometry('390px mobile viewport remains compact without horizontal overflow');
  await assertSticky();
  await screenshot('takeover-mobile.png');
  await page.setViewportSize({ width: 1024, height: 600 });
  await assertGeometry('short viewport observes the 45vh screenshot height limit');
  assert.deepEqual(errors, []); check('no uncaught UI errors');
  report.passed = true; report.finishedAt = new Date().toISOString();
  await rm(path.join(output, 'failure.png'), { force: true });
  console.log(`PASS isolated browser takeover/input: ${checks.length} checks; genuine HTTP, Chromium target, native IME and clipboard.`);
} catch (error) {
  report.passed = false; report.error = error.stack || String(error); process.exitCode = 1;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(report.error);
} finally {
  await stopMoli(); await browser?.close(); await vite?.close(); await broker?.close();
  if (target) await new Promise(resolve => { target.closeAllConnections(); target.close(resolve); });
  await rm(directory, { recursive: true, force: true }); report.temporaryPrivateDataRemoved = true;
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
