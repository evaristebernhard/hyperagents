// Real temporary owner/API/SQLite/run/browser acceptance. Model SSE is synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createApp } from '../server/app.mjs';
import privateDataPlugin, { privateFsDeny } from './private-data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), 'hyperagents-run-ui-'));
const evidence = path.join(root, 'docs/verification-run-continuation');
const freePort = () => new Promise((resolve, reject) => { const socket = net.createServer(); socket.on('error', reject); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
const frame = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const report = { startedAt: new Date().toISOString(), model: 'synthetic controlled SSE; no production inference', realHttp: true, realSqlite: true, apiInterception: false, checks: [], browserErrors: [], providerCalls: 0, passed: false };
let app, vite, browser, page, stage = 'held', heldSignal;
try {
  await mkdir(evidence, { recursive: true });
  const port = await freePort(), apiPort = await freePort(), base = `http://127.0.0.1:${port}`;
  const check = name => report.checks.push({ name, passed: true });
  const provider = async (_url, init) => {
    report.providerCalls++;
    if (stage === 'held') {
      heldSignal = init.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: 'Saved before restart.' } }] }))); init.signal.addEventListener('abort', () => controller.close(), { once: true }); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    const body = JSON.parse(init.body);
    assert.match(body.messages.at(-1).content, /继续未完成的任务/);
    assert.match(body.messages.at(-1).content, /Write a durable report/);
    assert.match(body.messages.at(-1).content, /Saved before restart/);
    return new Response(frame({ choices: [{ delta: { content: 'Remaining work completed from saved context.' }, finish_reason: 'stop' }] }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const start = async extra => { app = await createApp({ dataDir: dir, shellRoot: dir, port: apiPort, devOrigin: base, deepseekApiKey: 'synthetic-run-ui-key', llmFetch: provider, freeSearchDisabled: true, browserProvider: 'none', moliPath: '/nonexistent-test-moli', skillCatalog: [], integrationCredentials: {}, ...extra }); await app.listen(); };
  await start();
  vite = await createServer({ root, configFile: false, envFile: false, plugins: [privateDataPlugin(), react()], define: { 'import.meta.env.VITE_STORAGE_MODE': '"server"', 'import.meta.env.VITE_BACKEND_V1': '"false"' }, optimizeDeps: { entries: ['index.html'], esbuildOptions: { target: 'es2022' } }, server: { host: '127.0.0.1', port, strictPort: true, fs: { strict: true, deny: privateFsDeny }, watch: null, proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } } });
  await vite.listen(); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(base + '/threads/new');
  await page.getByLabel('Password', { exact: true }).fill('isolated-run-recovery-password');
  await page.getByLabel('Confirm password', { exact: true }).fill('isolated-run-recovery-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByLabel('Task prompt', { exact: true })).toBeVisible();
  await page.getByLabel('Task prompt', { exact: true }).fill('Write a durable report and retain the saved task after a restart.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page).toHaveURL(/\/thread\//); const threadId = new URL(page.url()).pathname.split('/')[2];
  await expect(page.getByLabel('Streaming answer')).toContainText('Saved before restart.');
  const getRuns = async () => (await (await page.request.get(base + '/api/runs?' + new URLSearchParams({ workspaceId: 'personal', threadId }))).json()).runs;
  const original = (await getRuns())[0]; assert.equal(original.status, 'running');
  await page.goto(base + '/threads'); assert.equal(heldSignal.aborted, false);
  assert.equal((await getRuns())[0].id, original.id); assert.equal(report.providerCalls, 1);
  check('closing the thread viewer leaves the same server execution active');

  await app.close(); app = undefined; stage = 'continue'; await start();
  await page.goto(base + '/thread/' + threadId);
  await expect(page.getByRole('button', { name: '从已保存上下文继续', exact: true })).toBeVisible();
  assert.equal((await getRuns())[0].status, 'interrupted'); assert.equal(report.providerCalls, 1);
  check('a real service restart preserves interrupted state and never auto-runs');
  await page.getByRole('button', { name: '从已保存上下文继续', exact: true }).click();
  await expect(page.getByLabel('Durable run status', { exact: true })).toContainText('Succeeded');
  await expect(page.locator('.rt-message.assistant:not([aria-label])').last()).toContainText('Remaining work completed from saved context.');
  await expect(page.getByRole('button', { name: '查看原运行', exact: true })).toBeVisible();
  const after = await getRuns(); assert.equal(after.length, 2); assert.equal(after[0].continuedFromRunId, original.id); assert.equal(report.providerCalls, 2);
  check('explicit continuation creates one linked run using the saved original goal and partial output');
  await page.getByRole('button', { name: '查看原运行', exact: true }).click();
  const log = page.getByRole('dialog', { name: '已保存的运行日志', exact: true });
  await expect(log).toContainText('Saved before restart.'); await expect(log).toContainText('Interrupted');
  assert.equal(report.providerCalls, 2);
  await page.keyboard.press('Escape'); await expect(log).toHaveCount(0);
  check('historical event viewing exposes saved partial output without execution');
  await page.reload(); await expect(page.getByRole('button', { name: '查看原运行', exact: true })).toBeVisible(); assert.equal(report.providerCalls, 2);
  await expect(page.getByLabel('Storage status', { exact: true })).toHaveText('Saved to local server');
  await expect(page.locator('.rt-message.assistant:not([aria-label])').last()).toBeInViewport();
  check('continuation origin, saved answer and history survive a full page reload');
  await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.rt-message.assistant:not([aria-label])').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.rt-message.assistant:not([aria-label])').last()).toBeInViewport();
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })); assert.ok(geometry.document <= geometry.viewport + 1);
  await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: true });
  check('390px continuation controls and saved run history have no document overflow');

  await app.close(); app = undefined;
  await start({ scnetModelConfig: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'synthetic-expired-key', model: 'test-qwen', jobId: '12345', deadlineUnix: Math.floor(Date.now() / 1000) - 1 } });
  await page.reload();
  await expect(page.getByText('DCU 作业已结束，消息、运行日志与产物仍保存在工作区。连接新的有效作业后，可从已保存上下文继续。', { exact: true })).toBeVisible();
  await expect(page.locator('.rt-message.assistant:not([aria-label])').last()).toContainText('Remaining work completed from saved context.');
  assert.equal(report.providerCalls, 2);
  check('expired allocation explains its deadline while keeping saved messages available');
  assert.deepEqual(report.browserErrors, []); report.passed = true; await rm(path.join(evidence, 'failure.png'), { force: true });
} catch (error) { report.error = error.message; if (page) await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally {
  await browser?.close(); await vite?.close(); await app?.close(); await rm(dir, { recursive: true, force: true }); report.temporaryDataRemoved = true; report.finishedAt = new Date().toISOString();
  await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, providerCalls: report.providerCalls, browserErrors: report.browserErrors.length }));
}
