// Explicit, isolated live acceptance. Never opens the original workspace or env.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { emptyState } from '../server/validation.mjs';
import { loadScnetAgentConfig } from '../server/scnet-agent-model.mjs';

const config = loadScnetAgentConfig();
if (!config) throw Error('Dedicated SCNet config required. No fallback provider is permitted.');
const restrictedConfig={...config,toolAllowlist:['web_search','create_artifact']};
const root = fileURLToPath(new URL('../../',import.meta.url)), directory = mkdtempSync(join(tmpdir(), 'hyper-real-scnet-'));
const report = { startedAt: new Date().toISOString(), scope: 'Fresh isolated legacy SQLite/account/workspace with real dedicated SCNet and keyless public RSS; no original account, browser profile or old paid API access', provider: config.provider, model: config.model, status: 'running', upstreamRequests: [], publicSearchRequests: [], cases: [], maxUpstreamRequests: 24 };
const copies = [], pendingAudits = []; let app, cookie, csrf, origin;
function log(value) { console.log(JSON.stringify(value)); }
const actualFetch = async (url, init) => {
  if (url !== config.baseUrl + '/chat/completions') throw Error('Refusing unexpected model origin');
  if (report.upstreamRequests.length >= report.maxUpstreamRequests) throw Error('Explicit live model request budget exhausted');
  const body = JSON.parse(init.body), entry = { number: report.upstreamRequests.length + 1, startedAt: new Date().toISOString(), stage: body.stream ? 'final_text' : body.messages[0].content.startsWith('Choose') ? 'tool_selection' : 'tool_arguments', inputBytes: Buffer.byteLength(body.messages.map(message => message.content).join('')), maxTokens: body.max_tokens };
  report.upstreamRequests.push(entry); const start = performance.now();
  const response = await fetch(url, init); entry.status = response.status; entry.headersMs = Math.round(performance.now() - start);
  log({ phase: 'upstream', ...entry });
  if (!body.stream && response.ok) {
    const audit = response.clone().json().then(value => { entry.finishReason = value.choices?.[0]?.finish_reason; entry.modelOutput = value.choices?.[0]?.message?.content; entry.usage = value.usage; }).catch(() => { entry.audit = 'invalid_json'; });
    pendingAudits.push(audit);
  }
  return response;
};
const publicFetch = async (url, init) => {
  if (new URL(url).origin !== 'https://cn.bing.com') throw Error('Only keyless Bing is authorized in this live acceptance');
  const entry = { startedAt: new Date().toISOString(), provider: 'public-bing-rss' }; report.publicSearchRequests.push(entry);
  const response = await fetch(url, init); entry.status = response.status; return response;
};
const call = async (path, method = 'GET', data, headers = {}) => fetch(origin + path, { method, signal: AbortSignal.timeout(10000), headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
async function runCase(label, question) {
  const current = await (await call('/api/state')).json(), thread = current.state.workspaces[0].data.threads.find(item => item.id === 'real-agent-thread');
  const selectedArtifactIds=label==='followup'?current.state.workspaces[0].data.artifacts.filter(artifact=>artifact.threadId===thread.id&&artifact.kind==='Document').slice(-1).map(artifact=>artifact.id):[];
  const messageId = randomUUID(); thread.messages.push({ id: messageId, role: 'user', text: question,...(selectedArtifactIds.length?{context:{settings:thread.config,skillIds:[],memoryIds:[],artifactIds:selectedArtifactIds,integrationIds:[],attachments:[]}}:{}) });
  const saved = await call('/api/state', 'PUT', { state: current.state }, { 'If-Match': String(current.revision) }); if (!saved.ok) throw Error('Fixture state save failed');
  const start = performance.now(), response = await call('/api/runs', 'POST', { workspaceId: 'personal', threadId: thread.id, userMessageId: messageId, model: config.model });
  const value = await response.json(); if (response.status !== 202) throw Error('Run was not admitted');
  const result = { label, question, selectedArtifactIds,runId: value.run.id, acceptedMs: Math.round(performance.now() - start), initialStatus: value.run.status }; report.cases.push(result); log({ phase: 'accepted', label, runId: value.run.id, acceptedMs: result.acceptedMs });
  let row;
  for (let attempt = 0; attempt < 170; attempt++) {
    row = (await (await call(`/api/runs/${result.runId}?workspaceId=personal&threadId=${thread.id}`)).json()).run;
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(row.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(row.status)) { await call(`/api/runs/${result.runId}/cancel`, 'POST', { workspaceId: 'personal', threadId: thread.id }); result.acceptanceTimeout = true; }
  result.run = (await (await call(`/api/runs/${result.runId}?workspaceId=personal&threadId=${thread.id}`)).json()).run;
  result.elapsedMs = Math.round(performance.now() - start);
  let cursor = 0; result.events = [];
  for (let page = 0; page < 10; page++) { const events = await (await call(`/api/runs/${result.runId}/events?workspaceId=personal&threadId=${thread.id}&after=${cursor}`)).json(); result.events.push(...events.events); cursor = events.nextCursor; if (!events.hasMore) break; }
  const after = await (await call('/api/state')).json(), workspace = after.state.workspaces[0];
  result.assistant = workspace.data.threads.find(item => item.id === thread.id).messages.find(message => message.id === 'run-answer-' + result.runId);
  result.artifacts = workspace.data.artifacts.map(artifact => ({ id: artifact.id, kind: artifact.kind, title: artifact.title, bytes: Buffer.byteLength(artifact.content), sha256: createHash('sha256').update(artifact.content).digest('hex'), versionCount: artifact.versions.length }));
  for (const artifact of workspace.data.artifacts) copies.push({ case: label, ...artifact });
  result.selectedTools = result.events.filter(event => event.event?.type === 'tool_trace' && event.event.phase === 'started').map(event => event.event.name);
  log({ phase: 'case_complete', label, status: result.run.status, selectedTools: result.selectedTools, artifacts: result.artifacts.length, elapsedMs: result.elapsedMs });
  return result;
}
try {
  app = await createApp({ dataDir: directory, port: 0, scnetModelConfig: restrictedConfig, llmFetch: actualFetch, publicFetch, exaApiKey: '', openAlexApiKey: '', runTimeoutMs: 150000 });
  const address = await app.listen(); origin = `http://127.0.0.1:${address.port}`;
  const setup = await call('/api/setup', 'POST', { password: randomUUID() + randomUUID() }); cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await setup.json()).csrfToken;
  const state = emptyState(); state.workspaces[0].data.threads.push({ id: 'real-agent-thread', title: '真实SCNet研究验收', summary: '', time: '', config: { model: config.model, provider: 'Any', reasoning: 'Medium', mode: 'Execute', tools: ['Search', 'Documents'] }, messages: [] });
  const current = await (await call('/api/state')).json(); const save = await call('/api/state', 'PUT', { state }, { 'If-Match': String(current.revision) }); if (!save.ok) throw Error('Isolated fixture initialization failed');
  report.configuration = await (await call('/api/llm/config')).json();
  await runCase('main', '查SQLite WAL官方文档，说明为何三人应用保存快但刷新慢，给有来源的简短建议并保存报告。');
  if (report.upstreamRequests.length < 20) await runCase('followup', '继续刚才的问题：请补充一句“增加分布式数据库不能直接修复界面等待刷新”，保留真实来源，并保存一份补充后的报告。');
  await Promise.allSettled(pendingAudits);
  report.status = report.cases.every(item => item.run.status === 'succeeded') && report.cases.some(item => item.artifacts.length > 0) && report.publicSearchRequests.length > 0 ? 'functional_pass_quality_review_required' : 'incomplete';
  report.limitations = ['These are real small-model decisions, not native function-call support or proof of general multi-step quality.', 'No hidden reasoning, original owner data or model key is included.', 'Source relevance and citation correctness must be reviewed against actual tool events and unedited output.', 'At most one main problem and one follow-up; model request budget includes decision/parameter calls and format repair.'];
} catch (error) { report.status = 'failed'; report.error = error.code || error.message; }
finally {
  await Promise.allSettled(pendingAudits);
  if (app) await app.close(); rmSync(directory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); report.cleanup = { temporaryWorkspaceRemoved: true, appClosed: true };
  mkdirSync(join(root, 'docs'), { recursive: true }); mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(join(root, 'docs/hyperagents-agent-live.json'), JSON.stringify(report, null, 2) + '\n');
  for (const [index, artifact] of copies.entries()) if (artifact.kind === 'Document') writeFileSync(join(root, `output/hyperagents-agent-${index + 1}.md`), artifact.content);
  log({ phase: 'finished', status: report.status, cases: report.cases.length, upstreamRequests: report.upstreamRequests.length, publicSearchRequests: report.publicSearchRequests.length, report: 'docs/hyperagents-agent-live.json' });
}
