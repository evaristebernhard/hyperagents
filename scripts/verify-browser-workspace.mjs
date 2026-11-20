// Actual UI -> authenticated Hyperagent API -> persistent broker -> Chromium.
// All data and browser identities are disposable; no model or real account is used.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createApp } from '../server/app.mjs';
import { startBrowserBroker } from '../../server/browser-broker.mjs';
import { launchPersistentBrowser } from '../../server/persistent-browser-driver.mjs';
import privateDataPlugin, { privateFsDeny } from './private-data.mjs';

// The production persistent driver belongs to the outer Elys package. Use that
// same Playwright installation to avoid loading two test-runner singletons.
const { chromium, expect } = createRequire(new URL('../../package.json', import.meta.url))('@playwright/test');

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/verification-browser-workspace');
const directory = await mkdtemp(path.join(tmpdir(), 'hyperagents-browser-workspace-'));
const token = randomBytes(32).toString('base64url');
const errors = [], checks = [];
const report = { startedAt: new Date().toISOString(), scope: 'Actual Hyperagent UI, authentication/CSRF, temporary SQLite, broker and real Chromium profiles. No model, API interception, production account or existing profile.', checks, browserErrors: errors, screenshots: [] };
let app, broker, vite, browser, page, driver, target, apiPort, uiPort, brokerPort;
const check = (name, detail) => checks.push({ name, passed: true, ...(detail ? { detail } : {}) });
const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer(); socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
let fixtureOrigin, baseURL;
const startBroker = async () => {
  broker = await startBrowserBroker({ dataDir: path.join(directory, 'broker'), token, port: brokerPort || 0, trustedOrigins: [fixtureOrigin], driverFactory: async options => {
    driver = await launchPersistentBrowser({ ...options, proxy: '' }); return driver;
  } });
  brokerPort = broker.port;
};
const readFixture = async () => {
  const text = (await driver.observe()).text;
  const match = text.match(/STATE:(\{[^\n]+\})/);
  assert.ok(match, 'real browser fixture state must be observable');
  return JSON.parse(match[1]);
};

try {
  await mkdir(output, { recursive: true });
  target = createHttpServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>浏览器验收 ${request.url}</title><style>body{margin:0;padding:32px;font:22px sans-serif;background:#f2f5fa;color:#25324b;height:1800px}button,input{position:absolute;left:40px;height:42px;padding:8px 15px;font:20px sans-serif}#count{top:100px}#entry{top:175px;width:400px}#save{top:250px}#state{position:absolute;top:330px;left:40px;white-space:pre-wrap;font:16px monospace}.foot{position:absolute;top:1500px}</style><h1>持久浏览器隔离验收</h1><button id="count">点击计数</button><input id="entry" aria-label="测试输入" autocomplete="off"><button id="save">保存测试身份</button><output id="state"></output><p class="foot">页面底部</p><script>let clicks=0;const entry=document.querySelector('#entry'),out=document.querySelector('#state');function update(){out.textContent='STATE:'+JSON.stringify({clicks,text:entry.value,cookie:document.cookie.includes('browser_fixture=yes'),local:localStorage.getItem('browser_fixture'),session:sessionStorage.getItem('browser_fixture'),path:location.pathname})}document.querySelector('#count').onclick=()=>{clicks++;update()};entry.oninput=update;document.querySelector('#save').onclick=()=>{document.cookie='browser_fixture=yes;Path=/;SameSite=Lax';localStorage.setItem('browser_fixture','fixture-local');sessionStorage.setItem('browser_fixture','fixture-session');update()};update();</script></html>`);
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  fixtureOrigin = `http://127.0.0.1:${target.address().port}`;
  await startBroker();
  uiPort = await freePort(); baseURL = `http://127.0.0.1:${uiPort}`;
  app = await createApp({ dataDir: path.join(directory, 'app'), port: 0, devOrigin: baseURL, persistentBrowserConfig: { url: `http://127.0.0.1:${brokerPort}`, token }, browserProvider: 'none', skillCatalog: [], integrationCredentials: {} });
  apiPort = (await app.listen()).port;
  vite = await createServer({ root, configFile: false, envFile: false, plugins: [privateDataPlugin(), react()], define: { 'import.meta.env.VITE_STORAGE_MODE': '"server"', 'import.meta.env.VITE_BACKEND_V1': '"false"' }, optimizeDeps: { entries: ['index.html'], esbuildOptions: { target: 'es2022' } }, server: { host: '127.0.0.1', port: uiPort, strictPort: true, watch: null, fs: { strict: true, deny: privateFsDeny }, proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const screenshot = async name => { await page.screenshot({ path: path.join(output, name), fullPage: true }); report.screenshots.push(name); };
  const state = async () => (await (await page.request.get(baseURL + '/api/state')).json());
  const sessionList = async () => (await (await page.request.get(baseURL + '/api/browser/sessions?workspaceId=personal')).json()).sessions;
  const waitFrame = async () => { await expect(page.locator('.pb-screen img')).toBeVisible(); await expect.poll(() => page.locator('.pb-screen img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true); };
  const clickRemote = async (x, y) => {
    await waitFrame(); await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeEnabled();
    await expect(page.locator('.pb-screen')).toHaveAttribute('data-click-ready', 'true');
    await page.locator('.pb-screen img').scrollIntoViewIfNeeded();
    const rect = await page.locator('.pb-screen img').boundingBox();
    await page.mouse.click(rect.x + x / 1280 * rect.width, rect.y + y / 800 * rect.height);
  };
  const navigate = async pathname => {
    await expect(page.getByRole('button', { name: '前往', exact: true })).toBeEnabled();
    await page.getByLabel('浏览器网址', { exact: true }).fill(fixtureOrigin + pathname);
    await page.getByRole('button', { name: '前往', exact: true }).click();
    await expect(page.getByLabel('浏览器网址', { exact: true })).toHaveValue(fixtureOrigin + pathname);
    await expect.poll(async () => (await readFixture()).path).toBe(pathname);
  };
  const noOverflow = async label => {
    const sizes = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(sizes.page <= sizes.viewport + 1 && sizes.body <= sizes.viewport + 1, JSON.stringify(sizes)); check(label, sizes);
  };

  await page.goto(baseURL + '/browser');
  await page.getByLabel('Password', { exact: true }).fill('isolated-browser-test-password');
  await page.getByLabel('Confirm password', { exact: true }).fill('isolated-browser-test-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('heading', { name: '浏览器工作台', exact: true })).toBeVisible();
  await expect(page.getByText('浏览器服务已连接', { exact: true })).toBeVisible();
  check('native browser route and sidebar use real authenticated Hyperagent API');
  await page.getByLabel('打开网页地址', { exact: true }).fill(fixtureOrigin + '/one');
  await page.getByRole('button', { name: '打开网页', exact: true }).click();
  await waitFrame();
  await expect(page.locator('.pb-state')).toHaveText('AI 控制');
  await expect(page.getByRole('button', { name: '前往', exact: true })).toBeDisabled();
  const first = (await sessionList())[0];
  assert.equal(first.url, fixtureOrigin + '/one');
  check('general URL opens real persistent Chromium, initially read-only');

  await page.getByRole('button', { name: '接管浏览器', exact: true }).click();
  await expect(page.locator('.pb-state')).toHaveText('你正在接管');
  await clickRemote(100, 120);
  await expect.poll(async () => (await readFixture()).clicks).toBe(1);
  await clickRemote(150, 195);
  await page.getByLabel('向网页输入', { exact: true }).fill('真实中文输入');
  await page.getByRole('button', { name: '输入到网页', exact: true }).click();
  await expect.poll(async () => (await readFixture()).text).toBe('真实中文输入');
  await clickRemote(150, 270);
  await expect.poll(async () => (await readFixture()).cookie).toBe(true);
  check('human screenshot click and masked IME input create actual temporary website identity');

  await navigate('/two');
  await expect(page.getByRole('button', { name: '后退一页', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '后退一页', exact: true }).click();
  await expect.poll(async () => (await readFixture()).path).toBe('/one');
  await expect(page.getByRole('button', { name: '前进一页', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '前进一页', exact: true }).click();
  await expect.poll(async () => (await readFixture()).path).toBe('/two');
  await expect(page.getByRole('button', { name: '重新加载网页', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重新加载网页', exact: true }).click();
  await expect.poll(async () => (await readFixture()).cookie).toBe(true);
  check('back, forward and reload navigate actual Chromium history without clearing identity');

  const oldTabIds = first.tabs.map(tab => tab.id);
  await expect(page.getByRole('button', { name: '新建标签页', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await expect.poll(async () => (await sessionList())[0].tabs.length).toBe(2);
  await waitFrame();
  let latest = (await sessionList())[0];
  const addedTab = latest.tabs.find(tab => !oldTabIds.includes(tab.id));
  assert.ok(addedTab); assert.equal(latest.activeTabId, addedTab.id);
  await expect(page.locator('.pb-tab.pb-active .pb-tab-close')).toBeEnabled();
  await page.locator('.pb-tab.pb-active .pb-tab-close').click();
  await expect.poll(async () => (await sessionList())[0].tabs.length).toBe(1);
  check('new and close tab controls mutate actual persistent browser tabs');

  await page.getByLabel('画面缩放', { exact: true }).selectOption('1.5');
  await page.reload();
  await waitFrame();
  await expect(page.getByLabel('画面缩放', { exact: true })).toHaveValue('1.5');
  assert.equal((await sessionList())[0].id, first.id);
  await expect(page.locator('.pb-state')).toHaveText('你正在接管');
  const savedViews = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('hyperagents:browser-view:')));
  assert.ok(savedViews.length > 0);
  for (const [, value] of savedViews) {
    const preference = JSON.parse(value);
    assert.deepEqual(Object.keys(preference).sort(), ['sessionId', 'zoom']);
    assert.equal(preference.sessionId, first.id);
  }
  check('refresh restores same human-controlled session and zoom; local preference stores only identifiers and zoom');
  await page.getByLabel('画面缩放', { exact: true }).selectOption('fit');
  await page.getByRole('button', { name: /会话与身份/ }).click();
  await expect(page.getByLabel('已保存浏览器会话')).toContainText('身份 ');
  await screenshot('workspace-desktop.png');
  await noOverflow('desktop browser workspace has no horizontal overflow');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('390px browser workspace has no horizontal overflow');
  await screenshot('workspace-mobile.png');
  await page.locator('.pb-screen').scrollIntoViewIfNeeded();
  await screenshot('workspace-mobile-screen.png');
  await page.setViewportSize({ width: 1440, height: 1100 });

  await page.getByRole('button', { name: '交还 AI', exact: true }).click();
  await expect(page.locator('.pb-state')).toHaveText('AI 控制');
  await page.getByRole('button', { name: '关闭浏览器（保留登录资料）', exact: true }).click();
  await expect(page.getByRole('button', { name: '使用原登录资料重开', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '使用原登录资料重开', exact: true }).click();
  await waitFrame();
  await expect.poll(async () => (await readFixture()).cookie).toBe(true);
  let reopened = (await sessionList())[0];
  assert.notEqual(reopened.id, first.id); assert.equal(reopened.profileId, first.profileId);
  assert.equal((await readFixture()).local, 'fixture-local');
  assert.equal((await readFixture()).session, 'fixture-session');
  check('closing and reopening preserves exact profile, cookie, localStorage and sessionStorage');

  await page.getByLabel('浏览器会话', { exact: true }).selectOption(first.id);
  await expect(page.getByRole('button', { name: '使用原登录资料重开', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('浏览器会话', { exact: true })).toHaveValue(first.id);
  await expect(page.getByRole('button', { name: '使用原登录资料重开', exact: true })).toBeVisible();
  await page.getByLabel('浏览器会话', { exact: true }).selectOption(reopened.id);
  await waitFrame();
  check('saved older session selection survives reload even while a newer session exists');

  await page.getByRole('button', { name: '接管浏览器', exact: true }).click();
  await waitFrame();
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await expect.poll(async () => (await sessionList())[0].tabs.length).toBe(2);
  reopened = (await sessionList())[0];
  const activeBeforeRestart = await readFixture();
  await broker.close(); broker = undefined;
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.getByText('浏览器连接已中断', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '前往', exact: true })).toBeDisabled();
  check('controller outage is visible and disables stale human controls');
  await startBroker();
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复原浏览器', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复原浏览器', exact: true }).click();
  await waitFrame();
  await expect(page.locator('.pb-state')).toHaveText('已暂停');
  latest = (await sessionList())[0];
  assert.equal(latest.id, reopened.id); assert.equal(latest.profileId, reopened.profileId);
  assert.equal(latest.tabs.length, 2); assert.equal(latest.activeTabId, reopened.activeTabId);
  await expect.poll(async () => (await readFixture()).cookie).toBe(true);
  assert.equal((await readFixture()).local, 'fixture-local');
  assert.equal((await readFixture()).session, activeBeforeRestart.session);
  check('broker restart explicitly restores same profile, selected tab, two tabs and website state while control stays paused');
  await page.getByRole('button', { name: '接管浏览器', exact: true }).click();
  await waitFrame();
  await page.locator('.pb-tab:not(.pb-active) [aria-pressed]').click();
  await expect.poll(async () => (await readFixture()).session).toBe('fixture-session');
  check('same-origin tabs retain separate sessionStorage values after controller restart');

  const current = await state(), ownerSession = await (await page.request.get(baseURL + '/api/session')).json();
  const source = current.state.workspaces[0];
  current.state.workspaces.push({ id: 'isolated-browser-workspace', name: '独立浏览器工作区', data: Object.fromEntries(Object.keys(source.data).filter(key => Array.isArray(source.data[key])).map(key => [key, []])) });
  current.state.active = 'isolated-browser-workspace';
  const saved = await page.request.put(baseURL + '/api/state', { headers: { Origin: baseURL, 'X-CSRF-Token': ownerSession.csrfToken, 'If-Match': String(current.revision) }, data: { state: current.state } });
  assert.equal(saved.status(), 200);
  await page.reload();
  await expect(page.getByRole('heading', { name: '浏览器工作台', exact: true })).toBeVisible();
  await expect(page.getByLabel('打开网页地址', { exact: true })).toBeVisible();
  await expect(page.locator('.pb-screen img')).toHaveCount(0);
  check('switching workspace cannot restore or expose another workspace browser');
  assert.deepEqual(errors, []); check('no uncaught browser errors');
  report.passed = true; report.finishedAt = new Date().toISOString();
  await rm(path.join(output, 'failure.png'), { force: true });
  console.log(`PASS browser workspace: ${checks.length} checks; real Chromium, broker and authenticated Hyperagent.`);
} catch (error) {
  report.passed = false; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(report.error);
} finally {
  await browser?.close(); await vite?.close(); await app?.close(); await broker?.close();
  if (target) await new Promise(resolve => { target.closeAllConnections(); target.close(resolve); });
  await rm(directory, { recursive: true, force: true }); report.temporaryPrivateDataRemoved = true;
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
