// Real SCNet -> real UI -> isolated authenticated API -> disposable broker ->
// real Chromium -> public first-party demo. No intercepted model/browser replies.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createApp } from '../server/app.mjs';
import { loadScnetAgentConfig } from '../server/scnet-agent-model.mjs';
import { startBrowserBroker } from '../../server/browser-broker.mjs';
import { launchPersistentBrowser } from '../../server/persistent-browser-driver.mjs';
import privateDataPlugin, { privateFsDeny } from './private-data.mjs';

// Use the driver's Playwright installation: no existing browser/CDP/profile.
const { chromium, expect } = createRequire(new URL('../../package.json', import.meta.url))('@playwright/test');
assert.deepEqual(process.argv.slice(2), ['--run'], 'Explicit --run is required for real model/browser acceptance');
const config = loadScnetAgentConfig();
assert.ok(config?.deadlineUnix && config.deadlineUnix * 1000 > Date.now(), 'An active finite dedicated SCNet configuration is required');
assert.ok(process.env.HTTPS_PROXY, 'The existing HTTPS_PROXY must be available for the public demo');
const root = fileURLToPath(new URL('../', import.meta.url));
const identifier = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = path.resolve(process.env.HANDOFF_LIVE_OUTPUT || path.join(root, 'docs/verification-browser-handoff-live', identifier));
const directory = await mkdtemp(path.join(tmpdir(), 'hyper-handoff-live-'));
const demoUrl = 'https://hyper.chayu123.me/browser-handoff-demo.html';
const question = '打开' + demoUrl + '，调用browser_request_takeover等待我填写测试昵称并完成演示注册。不要替我填写。明确交还后读取实际页面，只回复页面显示的测试昵称。';
const maximumMs = Math.max(1000, Math.min(220000, config.deadlineUnix * 1000 - Date.now() - 30000));
const report = { startedAt: new Date().toISOString(), passed: false, mode: 'real-model-real-browser', model: config.model, allocation: { jobId: config.jobId, deadlineUnix: config.deadlineUnix },
  scope: 'Disposable owner/SQLite/API/Vite/browser broker/Chromium profiles; real SCNet inference and first-party public demo through existing HTTPS_PROXY. No production broker, user registration, existing cookie/profile, external account or provider/browser fixture.',
  demoUrl, question, maximumMs, maxUpstreamRequests: 90, checks: [], upstreamRequests: [], browserRequests: [], browserErrors: [], screenshots: [],
  adapterSha256: createHash('sha256').update(await readFile(new URL('../server/scnet-agent-model.mjs', import.meta.url))).digest('hex') };
let app, broker, vite, browser, context, page, base, runId, overallTimer, endAt;
const pendingAudits = [], operator = new AbortController();
const check = name => report.checks.push(name);
const log = value => console.log(JSON.stringify(value));
const remaining = () => Math.max(1, endAt - Date.now());
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
async function uiGet(route) {
  return page.evaluate(async route => { const response = await fetch(route); if (!response.ok) throw Error('Isolated API read failed: ' + response.status); return response.json(); }, route);
}
async function allEvents(id) {
  let after = 0; const events = [];
  for (;;) { const value = await uiGet(`/api/runs/${id}/events?after=${after}`); events.push(...value.events); if (!value.hasMore) return events; after = value.nextCursor; }
}
async function until(fn, label) {
  while (Date.now() < endAt) { operator.signal.throwIfAborted(); const value = await fn(); if (value) return value; await delay(Math.min(250, remaining()), undefined, { signal: operator.signal }); }
  throw Error(label + ' exceeded the real acceptance deadline');
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(output, name), fullPage: true }); report.screenshots.push(name);
}
async function remoteClick(point, viewport) {
  await expect(page.locator('.pb-screen')).toHaveAttribute('data-click-ready', 'true', { timeout: Math.min(20000, remaining()) });
  const image = page.locator('.pb-screen img'); await image.scrollIntoViewIfNeeded();
  const bounds = await image.boundingBox(); assert.ok(bounds?.width && bounds?.height, 'Actual screenshot geometry is required');
  await page.mouse.click(bounds.x + point.x / viewport.width * bounds.width, bounds.y + point.y / viewport.height * bounds.height);
}
async function main() {
  await mkdir(output, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  broker = await startBrowserBroker({ dataDir: path.join(directory, 'broker'), token, port: 0,
    driverFactory: options => launchPersistentBrowser({ ...options, proxy: process.env.HTTPS_PROXY }) });
  assert.notEqual(broker.port, 19334, 'Never use the production broker port');
  const uiPort = await freePort(); base = `http://127.0.0.1:${uiPort}`;
  app = await createApp({ dataDir: path.join(directory, 'app'), port: 0, devOrigin: base, runTimeoutMs: maximumMs,
    persistentBrowserConfig: { url: `http://127.0.0.1:${broker.port}`, token }, scnetModelConfig: config,
    freeSearchDisabled: true, exaApiKey: '', openAlexApiKey: '', skillCatalog: [], integrationCredentials: {},
    llmFetch: async (url, init) => {
      assert.equal(url, config.baseUrl + '/chat/completions'); assert.ok(report.upstreamRequests.length < 90, 'Real model upstream request budget exhausted');
      const input = JSON.parse(init.body), entry = { number: report.upstreamRequests.length + 1, time: new Date().toISOString(),
        stage: input.stream ? 'final' : input.messages[0].content.startsWith('Choose') ? 'select' : 'arguments', inputMessages: input.messages };
      report.upstreamRequests.push(entry);
      const response = await fetch(url, { ...init, signal: AbortSignal.any([init.signal, operator.signal]) }); entry.status = response.status;
      if (response.ok && !input.stream) pendingAudits.push(response.clone().json().then(value => { entry.output = value.choices?.[0]?.message?.content; entry.finishReason = value.choices?.[0]?.finish_reason; entry.usage = value.usage; }).catch(() => { entry.audit = 'invalid_json'; }));
      log({ phase: 'model_response', number: entry.number, stage: entry.stage, status: entry.status }); return response;
    } });
  const apiPort = (await app.listen()).port;
  vite = await createServer({ root, configFile: false, envFile: false, plugins: [privateDataPlugin(), react()],
    define: { 'import.meta.env.VITE_STORAGE_MODE': '"server"', 'import.meta.env.VITE_BACKEND_V1': '"false"' },
    optimizeDeps: { entries: ['index.html'], esbuildOptions: { target: 'es2022' } },
    server: { host: '127.0.0.1', port: uiPort, strictPort: true, watch: null, fs: { strict: true, deny: privateFsDeny }, proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } } });
  await vite.listen();
  report.resources = { uiPort, apiPort, temporaryBrokerPort: broker.port, productionBrokerAccessed: false };
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url()); if (!url.pathname.startsWith('/api/browser/')) return;
    const request = response.request(), entry = { method: request.method(), path: url.pathname, status: response.status(), time: new Date().toISOString() };
    if (request.method() === 'POST') { try { entry.body = request.postDataJSON(); } catch {} }
    report.browserRequests.push(entry);
  });
  await page.goto(base + '/threads/new');
  const password = randomUUID() + randomUUID();
  await page.getByLabel('Password', { exact: true }).fill(password); await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByLabel('Task prompt', { exact: true })).toBeVisible();
  await page.evaluate(async model => {
    const session = await (await fetch('/api/session')).json(), current = await (await fetch('/api/state')).json();
    current.state.workspaces[0].data.threads.push({ id: 'real-handoff', title: '真实模型与浏览器接管验收', summary: '', time: '',
      config: { model, provider: 'SCNet DCU', mode: 'Execute', reasoning: 'Low', tools: ['Browser'] }, messages: [] });
    const saved = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': String(current.revision), 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ state: current.state }) });
    if (!saved.ok) throw Error('Isolated empty thread save failed');
  }, config.model);
  await page.goto(base + '/thread/real-handoff');
  await page.getByLabel('Follow-up message', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  log({ phase: 'submitted_real_ui_task', model: config.model });
  const waiting = await until(async () => {
    const listed = await uiGet('/api/runs?workspaceId=personal&threadId=real-handoff');
    if (!listed.runs.length) return false;
    const run = listed.runs[0]; runId = run.id; report.run = run;
    const events = await allEvents(runId); report.events = events;
    const event = events.find(item => item.event.type === 'browser_handoff' && item.event.status === 'waiting');
    if (event) return { run, event };
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) throw Error('Real model ended before confirmed human waiting: ' + (run.error || run.status));
    return false;
  }, 'Model takeover');
  assert.ok(waiting.event.event.sessionId); report.waiting = waiting.event; report.modelRequestsAtWait = report.upstreamRequests.length;
  await expect(page.getByLabel('Durable run status', { exact: true })).toContainText('等待你操作浏览器');
  check('Real model invokes browser takeover and actual persisted waiting reaches the thread UI'); await screenshot('waiting.png');
  // Reload must only replay history, never restart or hand back the browser.
  await page.reload(); await expect(page.getByLabel('Durable run status', { exact: true })).toContainText('等待你操作浏览器');
  assert.equal(report.upstreamRequests.length, report.modelRequestsAtWait); check('UI reload preserves the real pending handoff without another model request');
  await page.getByRole('button', { name: '打开等待中的浏览器', exact: true }).click();
  await expect(page.getByLabel('浏览器网址', { exact: true })).toHaveValue(demoUrl);
  await page.getByRole('button', { name: '接管浏览器', exact: true }).click();
  await expect(page.locator('.pb-state')).toHaveText('你正在接管');
  await expect(page.locator('.pb-screen')).toHaveAttribute('data-click-ready', 'true');
  const dimensions = await page.locator('.pb-screen img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert.deepEqual(dimensions, { width: 1280, height: 800 });
  // The operator reads geometry from a separate REAL, unmodified copy of the
  // same public demo. All writes below go through the actual screenshot panel.
  const measuring = await browser.newContext({ viewport: dimensions, proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
  try {
    const target = await measuring.newPage(); await target.goto(demoUrl, { waitUntil: 'networkidle', timeout: Math.min(20000, remaining()) });
    const nickname = await target.getByLabel('测试昵称', { exact: true }).boundingBox(), submit = await target.getByRole('button', { name: '完成演示注册', exact: true }).boundingBox();
    assert.ok(nickname && submit); report.operatorGeometry = { source: 'Independent read-only real public demo with identical Chromium viewport; no DOM writes', nickname, submit };
  } finally { await measuring.close(); }
  const nonce = 'handoff-' + randomBytes(8).toString('hex'); report.operatorNonce = nonce;
  const { nickname, submit } = report.operatorGeometry;
  await remoteClick({ x: nickname.x + nickname.width / 2, y: nickname.y + nickname.height / 2 }, dimensions);
  await page.getByLabel('向网页输入', { exact: true }).fill(nonce); await page.getByRole('button', { name: '输入到网页', exact: true }).click();
  await until(() => report.browserRequests.some(item => item.path.endsWith('/input') && item.status === 200 && item.body?.type === 'text' && item.body.text === nonce), 'Real nickname input');
  await remoteClick({ x: submit.x + submit.width / 2, y: submit.y + submit.height / 2 }, dimensions);
  await until(() => report.browserRequests.filter(item => item.path.endsWith('/input') && item.status === 200 && item.body?.type === 'click').length >= 2, 'Real demo submit');
  assert.equal(report.upstreamRequests.length, report.modelRequestsAtWait, 'Model remains paused while the operator uses the browser');
  check('Operator takes control and submits a nonce through actual screenshot clicks and authenticated input requests');
  await screenshot('operator-completed-demo.png');
  await page.getByRole('button', { name: '交还 AI', exact: true }).click();
  await expect(page.locator('.pb-state')).toHaveText('AI 控制');
  const completed = await until(async () => {
    const value = await uiGet('/api/runs/' + runId); report.run = value.run;
    return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.run.status) ? value.run : false;
  }, 'Real model post-handback answer');
  report.events = await allEvents(runId);
  const handoffs = report.events.filter(item => item.event.type === 'browser_handoff');
  assert.deepEqual(handoffs.map(item => item.event.status), ['waiting', 'resumed']);
  assert.equal(handoffs[0].event.sessionId, handoffs[1].event.sessionId); assert.ok(handoffs[1].event.epoch > handoffs[0].event.epoch);
  assert.equal(completed.status, 'succeeded', completed.error); assert.equal(completed.resultSaved, true);
  const state = await uiGet('/api/state'), thread = state.state.workspaces[0].data.threads.find(item => item.id === 'real-handoff');
  report.answer = thread.messages.find(message => message.id === 'run-answer-' + runId)?.text;
  assert.ok(report.answer?.includes(nonce), 'The real model must return the operator nonce, which was never in its task prompt');
  assert.ok(report.events.some(item => item.event.type === 'tool' && item.event.name === 'browser_request_takeover' && item.event.status === 'success'));
  assert.ok(report.upstreamRequests.slice(report.modelRequestsAtWait).some(item => JSON.stringify(item.inputMessages).includes(nonce)), 'Post-handback actual model context must contain the observed nonce');
  check('Explicit handback records waiting→resumed for the same session and feeds a real nonce-bearing observation to the model');
  check('Real model output contains the operator nonce and the final answer is saved in the isolated thread');
  await page.keyboard.press('Escape'); await screenshot('real-model-answer.png');
  await page.reload(); await expect(page.locator('.rt-message.assistant:not([aria-label])').last()).toContainText(nonce);
  assert.deepEqual((await allEvents(runId)).filter(item => item.event.type === 'browser_handoff').map(item => item.event.status), ['waiting', 'resumed']);
  check('Reload preserves the actual final answer and handoff/tool history'); report.passed = true;
}

try {
  endAt = Date.now() + maximumMs;
  await Promise.race([main(), new Promise((_, reject) => { overallTimer = setTimeout(() => { operator.abort(Error('Real acceptance exceeded its wall-clock budget')); reject(Error('Real acceptance exceeded ' + maximumMs + 'ms')); }, maximumMs); })]);
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  clearTimeout(overallTimer);
  if (page && !page.isClosed()) {
    try {
      if (runId) { report.events = await allEvents(runId); report.run = (await uiGet('/api/runs/' + runId)).run; report.visibleAnswer = report.events.filter(item => item.event.type === 'delta').map(item => item.event.text).join(''); }
      if (!report.passed) await screenshot('failure.png');
    } catch { report.failureSnapshotUnavailable = true; }
  }
  operator.abort(Error('Isolated acceptance cleanup'));
  const cleanup = [];
  for (const [name, close] of [['uiBrowser', () => browser?.close()], ['vite', () => vite?.close()], ['app', () => app?.close()], ['broker', () => broker?.close()]]) {
    try { await close(); cleanup.push({ resource: name, closed: true }); } catch (error) { cleanup.push({ resource: name, closed: false, error: error.message }); }
  }
  report.cleanup = cleanup; await Promise.allSettled(pendingAudits);
  await rm(directory, { recursive: true, force: true }); report.temporaryPrivateDataRemoved = true; report.finishedAt = new Date().toISOString();
  report.limitations = ['A real first-party demo and operator automation, not the user\'s current registration or a real external account.', 'Only this one bounded model/browser task is evaluated; semantic success is not inferred from a succeeded run status.'];
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  log({ passed: report.passed, model: report.model, modelRequests: report.upstreamRequests.length, checks: report.checks.length, report: path.join(output, 'results.json'), error: report.error });
}
