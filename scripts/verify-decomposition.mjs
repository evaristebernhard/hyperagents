// Reproducible authenticated /api/runs acceptance. Fixture decisions are explicitly
// synthetic; --live requires a finite, separately authorized SCNet allocation.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createApp } from '../server/app.mjs';
import { emptyState } from '../server/validation.mjs';
import { loadScnetAgentConfig } from '../server/scnet-agent-model.mjs';

const args = process.argv.slice(2), live = args.includes('--live'), inProcess = args.includes('--in-process'), core = args.includes('--core'), selectionZh = args.includes('--selection-zh');
assert.ok(args.every(arg => ['--live', '--fixture', '--in-process', '--core', '--selection-zh'].includes(arg)), 'Use --fixture (default) or --live, optionally --in-process or --core --selection-zh');
assert.ok(!(args.includes('--live') && args.includes('--fixture')), 'Select one model mode');
assert.ok(!core || live, '--core is an explicitly live-only diagnostic; it has no synthetic model path');
assert.ok(!selectionZh || live && core, '--selection-zh is an explicit live core diagnostic only');
if (live) assert.ok(process.env.HYPERAGENTS_SCNET_ENV_FILE, '--live requires explicit HYPERAGENTS_SCNET_ENV_FILE');
const config = live ? loadScnetAgentConfig() : undefined;
if (live) assert.ok(config?.deadlineUnix && config.deadlineUnix * 1000 > Date.now(), 'An active finite SCNet allocation is required');
// Finish within the actual remaining allocation and leave time to retain logs.
const liveBudgetMs = live ? Math.max(1000, Math.min(220000, config.deadlineUnix * 1000 - Date.now() - 30000)) : 15000;
const out = resolve(process.env.HYPERAGENTS_DECOMPOSITION_OUTPUT || new URL('../docs/verification-decomposition/', import.meta.url).pathname);
const directory = await mkdtemp(join(tmpdir(), 'hyper-decomposition-'));
const adapterSha256 = createHash('sha256').update(await readFile(new URL('../server/scnet-agent-model.mjs', import.meta.url))).digest('hex');
const scriptSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const chineseSelectionInstruction = '选择完成用户目标所需的下一个真实函数。只返回一个JSON对象 {"action":"tool","name":"准确函数名"} 或 {"action":"answer"}。name必须来自授权目录。只有所有请求的工作都有实际结果才能选择action=answer。不要虚构工具调用或结果。';
const sourceId = 'warehouse-brief';
const brief = '仓储演练简报，2026-11-12：现货75件；预计11月14日到货20件，但尚未核实实际到货；客户要求11月15日前交付110件。未授权下单、通知客户或修改库存。';
const coreBrief = '现货75件，预计到货20件但未核实，需求110件。';
const question = core ? '[ROOT] 先list_agents取得真实id；再按返回id分别delegate_agent给数量核算员和履约风险员。任务各附用户简报：' + coreBrief + '收回两份实际结果后，保存中文Document，含算式、来源“用户简报”、假设和下一步。不下单、不联系客户。' : '[ROOT] 读取warehouse-brief：委派capacity核数量、risk查到货风险；收回两份结果，保存含来源、缺口、到货假设和建议的中文Document。先list_agents和update_plan；两个子任务各read_document读取原文。计划用childRunId绑定子运行，报告步骤dependsOn前两步；等待结果后完成计划。不下单、不联系客户。';
const report = { startedAt: new Date().toISOString(), mode: live ? 'live-scnet' : 'deterministic-provider-fixture', scenario: core ? 'core-delegation-minimal-catalog' : 'source-read-dependency-plan', diagnostic: selectionZh ? { name:'selection-zh-only', chineseSelectionInstruction, modifies:'Only the system instruction of actual outgoing selection requests. Goal/context/catalog/candidates, arguments, final text and every host check remain unchanged.' } : null, transport: inProcess ? 'in-process HTTP handler; no TCP socket' : 'loopback HTTP', runtime: 'authenticated legacy /api/runs; same runtime as npm run dev', model: config?.model || 'synthetic-tool-decisions', ...(config ? { allocation: { jobId:config.jobId, deadlineUnix:config.deadlineUnix } } : {}), runBudgetMs: liveBudgetMs, adapterSha256, scriptSha256, source: core ? { mode:'inline-user-brief', content:coreBrief } : { id: sourceId, content: brief }, question, checks: [], requests: [], status: 'running' };
let app, base, cookie, csrf, requestNumber = 0;
const pendingAudits = [];
const frame = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const syntheticResponse = (name, args, text) => new Response(frame({ choices: [{ delta: name ? { tool_calls: [{ index: 0, id: 'fixture-' + (++requestNumber), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text }, finish_reason: name ? 'tool_calls' : 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } });
const steps = (phase, children = []) => ({ steps: [{ id: 'capacity', title: '核算可交付数量', status: phase ? 'completed' : 'in_progress', ...(children[0] ? { childRunId: children[0].runId } : {}) }, { id: 'risk', title: '核查到货风险', status: phase ? 'completed' : 'pending', ...(children[1] ? { childRunId: children[1].runId } : {}) }, { id: 'report', title: '合并并保存建议', status: phase === 2 ? 'completed' : phase ? 'in_progress' : 'pending', dependsOn: ['capacity', 'risk'] }] });
function results(messages, name) {
  const ids = new Set(messages.flatMap(message => message.tool_calls || []).filter(call => call.function.name === name).map(call => call.id));
  return messages.filter(message => message.role === 'tool' && ids.has(message.tool_call_id)).map(message => JSON.parse(message.content));
}
function verifyResultsBeforeSynthesis(parentEvents, children) {
  const creation = parentEvents.find(item => item.event.type === 'tool' && item.event.name === 'create_artifact' && item.event.status === 'running');
  assert.ok(creation, 'The parent must actually invoke create_artifact');
  const receipts = parentEvents.filter(item => item.seq < creation.seq && item.event.type === 'tool' && item.event.status === 'success' &&
    ['delegate_agent','get_delegated_run','wait_for_delegated_run'].includes(item.event.name)).flatMap(item => {
    try { return [{ ...JSON.parse(item.event.summary), tool:item.event.name, eventSeq:item.seq }]; } catch { return []; }
  });
  return children.map(child => {
    const receipt = receipts.find(result => result.runId === child.id && result.status === 'succeeded' && result.resultSaved === true && typeof result.text === 'string' && result.text.trim());
    assert.ok(receipt, `The parent must receive the real saved result of child ${child.id} before its first create_artifact call`);
    return { runId:child.id, tool:receipt.tool, resultEventSeq:receipt.eventSeq, firstArtifactEventSeq:creation.seq };
  });
}
const fixtureFetch = async (_url, init) => {
  const input = JSON.parse(init.body), first = input.messages.find(message => message.role === 'user').content;
  report.requests.push({ role: first.startsWith('[ROOT]') ? 'parent' : first.startsWith('[CANCEL]') ? 'cancel-parent' : first.startsWith('[HOLD]') ? 'cancel-child' : first.startsWith('[CAPACITY]') ? 'capacity' : 'risk', tools: input.tools.map(tool => tool.function.name) });
  const tool = (name, args = {}) => syntheticResponse(name, args);
  if (first.startsWith('[HOLD]')) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  if (first.startsWith('[CANCEL]')) {
    const delegated = results(input.messages, 'delegate_agent');
    return delegated.length ? tool('wait_for_delegated_run', { runId: delegated[0].runId, timeoutSeconds: 30 }) : tool('delegate_agent', { agentId: 'capacity', task: '[HOLD] Wait for cancellation in this fixture only.' });
  }
  if (!first.startsWith('[ROOT]')) {
    assert.ok(!input.tools.some(tool => ['create_artifact', 'delegate_agent', 'shell_execute'].includes(tool.function.name)), 'Children have read-only tools');
    const documents = results(input.messages, 'read_document');
    if (!documents.length) return tool('read_document', { id: sourceId });
    assert.equal(documents[0].content, brief, 'The child receives the real saved source');
    const capacity = first.startsWith('[CAPACITY]');
    return syntheticResponse(undefined, undefined, capacity ? '数量核算：75+20=95件，110-95=15件缺口。该结果以20件按时到货为前提。来源：warehouse-brief。' : '履约风险：20件尚未核实到货，当前确定现货仅75件；若未到货，110-75=35件缺口。先核实到货，不能承诺足额交付。来源：warehouse-brief。');
  }
  const plans = results(input.messages, 'update_plan');
  if (!plans.length) return tool('update_plan', steps(0));
  if (!results(input.messages, 'list_agents').length) return tool('list_agents');
  const delegated = results(input.messages, 'delegate_agent');
  if (!delegated.length) return tool('delegate_agent', { agentId: 'capacity', task: '[CAPACITY] 调用 read_document 读取 warehouse-brief，核算现货加预计到货能交付多少、相对110件需求缺多少；说明到货假设，返回算式和来源。仅分析，不改库存。' });
  if (delegated.length < 2) return tool('delegate_agent', { agentId: 'risk', task: '[RISK] 调用 read_document 读取 warehouse-brief，独立核查到货未落实的交付风险；计算20件未到货时的缺口，建议下一步并注明来源。不联系客户或下单。' });
  const waited = results(input.messages, 'wait_for_delegated_run');
  const outstanding = delegated.find(child => !waited.some(result => result.runId === child.runId && result.status === 'succeeded'));
  if (outstanding) return tool('wait_for_delegated_run', { runId: outstanding.runId, timeoutSeconds: 10 });
  if (plans.length < 2) return tool('update_plan', steps(1, delegated));
  if (!results(input.messages, 'create_artifact').length) return tool('create_artifact', { title: '仓储交付建议', kind: 'Document', content: '# 仓储交付建议\n\n## 数量核算\n' + waited[0].text + '\n\n## 履约风险\n' + waited[1].text + '\n\n## 下一步\n先核实20件到货，再补足至少15件；在风险未解除前暂缓足额交付承诺。未下单、未联系客户、未修改库存。\n\n来源：warehouse-brief（2026-11-12仓储演练简报）。' });
  if (plans.length < 3) return tool('update_plan', steps(2, delegated));
  return syntheticResponse(undefined, undefined, '已合并两位子 agent 的实际结果并准备保存建议：预计95件，缺15件；若20件未到货则缺35件，先核实到货再承诺交付。');
};
async function call(route, method = 'GET', body, extra = {}) {
  const response = await transportFetch(base + route, { method, signal: AbortSignal.timeout(15000), headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify({ route, status: response.status, value })); return value;
}
async function transportFetch(url, init = {}) {
  if (!inProcess) return fetch(url, init);
  const parsed = new URL(url), req = Readable.from(init.body ? [Buffer.from(init.body)] : []);
  req.method = init.method || 'GET'; req.url = parsed.pathname + parsed.search; req.complete = true;
  req.headers = Object.fromEntries(Object.entries({ Host: parsed.host, ...init.headers }).map(([key, value]) => [key.toLowerCase(), value]));
  req.rawHeaders = Object.entries(req.headers).flat(); req.socket = { remoteAddress: '127.0.0.1' };
  const res = new EventEmitter(), headers = new Headers(); let status = 200, content = '';
  res.headersSent = false; res.destroyed = false; res.setHeader = (key, value) => headers.set(key, value);
  res.writeHead = (code, values = {}) => { status = code; for (const [key, value] of Object.entries(values)) headers.set(key, value); res.headersSent = true; };
  res.write = value => { content += value; return true; };
  const completed = new Promise((resolve, reject) => { res.end = value => { if (value) content += value; res.emit('finish'); resolve(new Response(content, { status, headers })); }; res.destroy = () => reject(Error('HTTP handler destroyed response')); });
  await app.server.listeners('request')[0](req, res); return completed;
}
async function until(fn, maximumMs = live ? liveBudgetMs + 2000 : 15000) { const start = Date.now(); while (Date.now() - start < maximumMs) { const value = await fn(); if (value) return value; await delay(100); } throw Error('Acceptance timed out'); }
async function waitRun(id) { return until(async () => { const { run } = await call('/api/runs/' + id); return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status) && run; }); }
async function events(id) { let cursor = 0, all = []; for (;;) { const page = await call(`/api/runs/${id}/events?after=${cursor}`); all.push(...page.events); cursor = page.nextCursor; if (!page.hasMore) return all; } }
try {
  const allowlist = core ? ['list_agents', 'delegate_agent', 'get_delegated_run', 'wait_for_delegated_run', 'create_artifact'] : ['update_plan', 'list_agents', 'delegate_agent', 'get_delegated_run', 'wait_for_delegated_run', 'read_document', 'create_artifact'];
  report.toolAllowlist = allowlist;
  const appOptions = { port: 0, dataDir: directory, runTimeoutMs: liveBudgetMs, ...(live ? { scnetModelConfig: { ...config, toolAllowlist: allowlist }, llmFetch: async (url, init) => {
    assert.equal(url, config.baseUrl + '/chat/completions'); assert.ok(report.requests.length < 90, 'Live upstream budget exhausted');
    const input = JSON.parse(init.body), stage = input.stream ? 'final' : Array.isArray(input.allowed_decisions) || input.messages[0].content.startsWith('Choose') ? 'select' : 'arguments';
    const originalSystemInstruction = input.messages[0].content;
    if (selectionZh && stage === 'select') { assert.equal(input.messages[0].role,'system'); input.messages[0] = { ...input.messages[0], content:chineseSelectionInstruction }; }
    const entry = { number:report.requests.length+1, stream:input.stream, stage, time:new Date().toISOString(), inputMessages:input.messages, requestBody:input,
      ...(selectionZh && stage === 'select' ? { selectionInstructionOverridden:true, originalSystemInstruction } : {}) };
    report.requests.push(entry);
    const response = await fetch(url, selectionZh && stage === 'select' ? { ...init, body:JSON.stringify(input) } : init); entry.status=response.status;
    if(response.ok&&!input.stream)pendingAudits.push(response.clone().json().then(value=>{entry.output=value.choices?.[0]?.message?.content;entry.finishReason=value.choices?.[0]?.finish_reason;entry.usage=value.usage;}).catch(()=>{entry.audit='invalid_json';}));
    console.log(JSON.stringify({phase:'model_response',number:entry.number,stage:entry.stage,status:entry.status}));return response;
  } } : { deepseekApiKey: 'synthetic-fixture-only', llmFetch: fixtureFetch }) };
  app = await createApp(appOptions);
  base = inProcess ? 'http://127.0.0.1:0' : 'http://127.0.0.1:' + (await app.listen()).port;
  const setup = await transportFetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: randomUUID() + randomUUID() }) });
  assert.equal(setup.status, 200); cookie = setup.headers.get('set-cookie').split(';')[0]; csrf = (await setup.json()).csrfToken;
  const initial = emptyState(), data = initial.workspaces[0].data, at = new Date().toISOString();
  const settings = { model: config?.model || 'deepseek-flash', provider: config?.provider || 'DeepSeek', reasoning: 'Low', mode: 'Execute', tools: ['Delegation', 'Documents'] };
  data.agents.push(...['capacity', 'risk'].map(id => ({ id, name: id === 'capacity' ? '数量核算员' : '履约风险员', description: id === 'capacity' ? '核算库存与缺口' : '检查到货风险', prompt: '只读分析所给任务；先读取指定来源，给出简短算式、假设和来源。', tools: ['Documents'] })));
  data.threads.push({ id: 'decomposition', title: '仓储交付建议演练', summary: '', time: '', config: settings, messages: [{ id: 'brief', role: 'user', text: question }] });
  if (!core) data.artifacts.push({ id: sourceId, kind: 'Document', title: '仓储演练简报', content: brief, createdAt: at, updatedAt: at, versions: [] });
  await call('/api/state', 'PUT', { state: initial }, { 'If-Match': '0' });
  const { run: admitted } = await call('/api/runs', 'POST', { workspaceId: 'personal', threadId: 'decomposition', userMessageId: 'brief' });
  report.run = admitted;
  const completed = await waitRun(admitted.id); report.run = completed;
  assert.equal(completed.status, 'succeeded', completed.error); assert.equal(completed.resultSaved, true); assert.equal(completed.childCount, 2);
  const saved = await call('/api/state'), current = saved.state.workspaces[0].data;
  report.children = [];
  for (const thread of current.threads.filter(thread => thread.id !== 'decomposition')) {
    const listed = await call(`/api/runs?workspaceId=personal&threadId=${thread.id}`), child = listed.runs.find(run => run.parentRunId === admitted.id);
    if (!child) continue;
    assert.equal(child.status, 'succeeded'); assert.equal(child.resultSaved, true);
    const traces = await events(child.id);
    if (!core) assert.ok(traces.some(item => item.event.type === 'tool' && item.event.name === 'read_document' && item.event.status === 'success'));
    else for (const fact of ['75', '20', '110']) assert.ok(thread.messages[0].text.includes(fact), 'Each self-contained child assignment retains source fact ' + fact);
    report.children.push({ id: child.id, parentRunId: child.parentRunId, agentId: thread.config.agentId, status: child.status, output: thread.messages.find(message => message.role === 'assistant')?.text, events: traces });
  }
  assert.deepEqual(report.children.map(child => child.agentId).sort(), ['capacity', 'risk']);
  assert.notEqual(report.children[0].output, report.children[1].output);
  const artifacts = current.artifacts.filter(artifact => artifact.threadId === 'decomposition' && artifact.kind === 'Document');
  assert.equal(artifacts.length, 1); const artifact = artifacts[0]; report.artifact = { id: artifact.id, title: artifact.title, content: artifact.content };
  for (const fact of ['95', '15', '35']) assert.match(artifact.content, new RegExp('(?<!\\d)' + fact + '(?!\\d)'), 'Saved document must include exact number ' + fact);
  assert.ok(artifact.content.includes(core ? '用户简报' : sourceId), 'Saved document must include the source reference');
  assert.match(artifact.content, /核实|确认|未到货/); assert.match(artifact.content, /下一步|建议|先/);
  if (!core) {
    assert.ok(completed.plan?.length >= 3 && completed.plan.every(step => step.status === 'completed'));
    const reportStep = completed.plan.find(step => step.dependsOn?.length === 2 &&
      report.children.every(child => step.dependsOn.some(id => completed.plan.find(candidate => candidate.id === id)?.childRunId === child.id)));
    assert.ok(reportStep, 'A synthesis step must depend on the two steps linked to actual saved child results');
  }
  report.parentEvents = await events(admitted.id);
  report.resultReceiptOrder = verifyResultsBeforeSynthesis(report.parentEvents, report.children);
  if (!live) {
    // Exercise the gate against the actual fixture history: final child/plan
    // success cannot excuse an early artifact or an unsaved/running receipt.
    const isReceipt = item => item.event.type === 'tool' && item.event.status === 'success' && ['delegate_agent','get_delegated_run','wait_for_delegated_run'].includes(item.event.name);
    const earlyArtifact = report.parentEvents.map(item => item.event.type === 'tool' && item.event.name === 'create_artifact' && item.event.status === 'running' ? {...item,seq:0} : item);
    assert.throws(() => verifyResultsBeforeSynthesis(earlyArtifact, report.children), /must receive the real saved result/);
    const unconfirmed = report.parentEvents.map(item => isReceipt(item) ? {...item,event:{...item.event,summary:JSON.stringify({...JSON.parse(item.event.summary),status:'running',resultSaved:false})}} : item);
    assert.throws(() => verifyResultsBeforeSynthesis(unconfirmed, report.children), /must receive the real saved result/);
    assert.throws(() => verifyResultsBeforeSynthesis(report.parentEvents.filter(item=>!isReceipt(item)), report.children), /must receive the real saved result/);
    report.negativeOrderChecks = ['Early artifact rejected despite final child success', 'Running/unsaved result receipts rejected', 'Missing result receipts rejected'];
  }
  report.checks.push('Authenticated parent starts two isolated read-only child runs', core ? 'Both self-contained assignments retain all user facts and return distinct real model results' : 'Both children read the actual saved source and return distinct results', 'Parent waits for real results before synthesizing', 'One real Document is committed with 95/15/35 figures, source and arrival uncertainty');
  if (!core) report.checks.push('Three plan steps complete with report dependencies bound to the two real saved child runs');
  const same = await call('/api/runs', 'POST', { workspaceId: 'personal', threadId: 'decomposition', userMessageId: 'brief' }); assert.equal(same.run.id, admitted.id);
  report.checks.push('Repeated admission reuses the same completed run');
  if (!live) {
    const fresh = await call('/api/state'); fresh.state.workspaces[0].data.threads.push({ id: 'cancel', title: '取消演练', summary: '', time: '', config: settings, messages: [{ id: 'cancel-brief', role: 'user', text: '[CANCEL] Start one holding child, then wait.' }] });
    await call('/api/state', 'PUT', { state: fresh.state }, { 'If-Match': String(fresh.revision) });
    const { run: cancellation } = await call('/api/runs', 'POST', { workspaceId: 'personal', threadId: 'cancel', userMessageId: 'cancel-brief' });
    await until(async () => (await call('/api/runs/' + cancellation.id)).run.childCount === 1);
    await call(`/api/runs/${cancellation.id}/cancel`, 'POST', { workspaceId: 'personal', threadId: 'cancel' });
    report.cancellation = await waitRun(cancellation.id); assert.equal(report.cancellation.status, 'cancelled');
    const afterCancel = await call('/api/state');
    for (const thread of afterCancel.state.workspaces[0].data.threads.filter(thread => thread.id.startsWith('thread-delegated-'))) {
      const list = await call(`/api/runs?workspaceId=personal&threadId=${thread.id}`);
      for (const child of list.runs.filter(child => child.parentRunId === cancellation.id)) assert.equal((await waitRun(child.id)).status, 'cancelled');
    }
    report.checks.push('Cancelling a parent cancels its real holding child');
  }
  await app.close(); app = await createApp(appOptions);
  base = inProcess ? 'http://127.0.0.1:0' : 'http://127.0.0.1:' + (await app.listen()).port;
  const restored = await call('/api/state'), restoredArtifact = restored.state.workspaces[0].data.artifacts.find(item => item.id === artifact.id);
  assert.equal(restoredArtifact.content, artifact.content); assert.equal((await call('/api/runs/' + admitted.id)).run.status, 'succeeded');
  report.checks.push('Owner session, run tree, plan and exact saved document survive server reopen');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  if(app && report.status==='failed' && report.run) {
    try {
      report.parentEvents=await events(report.run.id);
      report.run=(await call('/api/runs/'+report.run.id)).run;
      const snapshot=await call('/api/state');
      report.partialArtifacts=snapshot.state.workspaces[0].data.artifacts.filter(artifact=>artifact.threadId==='decomposition').map(artifact=>({id:artifact.id,title:artifact.title,kind:artifact.kind,content:artifact.content}));
      report.visibleAnswer=report.parentEvents.filter(item=>item.event.type==='delta').map(item=>item.event.text).join('');
      report.partialChildren=[];
      for(const thread of snapshot.state.workspaces[0].data.threads.filter(thread=>thread.id.startsWith('thread-delegated-'))) {
        const listed=await call(`/api/runs?workspaceId=personal&threadId=${thread.id}`);
        for(const run of listed.runs.filter(run=>run.parentRunId===report.run.id))report.partialChildren.push({run,agentId:thread.config.agentId,events:await events(run.id)});
      }
    } catch { report.failureSnapshotUnavailable=true; }
  }
  await Promise.allSettled(pendingAudits);
  await app?.close(); await rm(directory, { recursive: true, force: true }); report.temporaryPrivateDataRemoved = true; report.finishedAt = new Date().toISOString();
  report.limitations = live ? ['A bounded case on one real model/allocation; not general agent reliability.', ...(core ? ['Core diagnostic supplies facts inline, limits the parent to delegation/document creation, and gives children no tool calls. It does not verify source reading, dependency plans, or the broader UI Documents tool catalog.'] : [])] : ['Provider decisions and prose are deterministic fixtures, not real model inference.', 'Actual owner authentication, tool authorization, saved source reads, child scheduling, events, SQLite persistence, document commits and cancellation are exercised.', 'This script targets the npm run dev runtime, not backend v1/Rust.'];
  await mkdir(out, { recursive: true }); await writeFile(join(out, live ? 'live.json' : 'fixture.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.artifact) await writeFile(join(out, live ? 'warehouse-report-live.md' : 'warehouse-report-fixture.md'), report.artifact.content + '\n');
  console.log(JSON.stringify({ status: report.status, mode: report.mode, checks: report.checks.length, children: report.children?.length || 0, report: join(out, live ? 'live.json' : 'fixture.json'), error: report.error }));
}
