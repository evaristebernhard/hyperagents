import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskRuntime } from './task-runtime.mjs';
import { emptyState } from './validation.mjs';

// These tests exercise observable scheduler/persistence behavior against real
// temporary SQLite databases. Every model and plugin is local and deterministic.
const options = { timeout: 12000 };
const scope = { workspaceId: 'personal' };
const modelName = 'test-model';
const finish = text => ({ text, toolCalls: [], assistantMessage: { role: 'assistant', content: text } });
const toolsResponse = calls => ({ text: '', toolCalls: calls, assistantMessage: { role: 'assistant', content: null, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } });
const tool = (id, name, args = {}) => ({ id, name, arguments: args });
const firstUser = messages => String(messages.find(message => message.role === 'user')?.content || '');
const hasUser = (messages, text) => messages.some(message => message.role === 'user' && String(message.content).includes(text));
const hasTool = (messages, text) => messages.some(message => message.role === 'tool' && String(message.content).includes(text));

function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function held(signal, valueGate) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || Error('aborted')); };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    valueGate.promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function poll(read, accept, label, timeout = 5000) {
  const until = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await delay(10);
  } while (Date.now() < until);
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(last?.task ? { task: last.task, children: last.children } : last)}`);
}
function registry(executors = {}) {
  const definitions = Object.entries(executors).map(([name]) => ({ type: 'function', function: { name, description: 'Local deterministic test plugin', parameters: { type: 'object', properties: {}, additionalProperties: false } } }));
  return {
    list: () => definitions.length ? [{ id: 'fixture', name: 'Fixture', description: 'Local test only', available: true, configured: true, defaultEnabled: true }] : [],
    bind({ pluginIds }) {
      const enabled = pluginIds.includes('fixture');
      return {
        definitions: () => enabled ? definitions : [],
        metadata(name) { const entry = enabled && executors[name]; return entry ? { pluginId: 'fixture', effect: entry.effect || 'read-only', replay: entry.replay || 'safe', approvalRequired: entry.approvalRequired ?? entry.effect === 'write' } : undefined; },
        execute(name, args, context) { const entry = enabled && executors[name]; if (!entry) throw Error('Unknown plugin tool'); return entry.execute(args, context); },
        close: async () => {},
      };
    },
  };
}
async function harness(t, { step, plugins = registry(), ...extra } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'task-runtime-'));
  const state = emptyState(), calls = [], supervisedBriefs = new Map();
  const model = { configured: true, models: [modelName], step: async input => {
    calls.push({ ...input, messages: structuredClone(input.messages) });
    const workerBrief = supervisedBriefs.get(firstUser(input.messages));
    if (workerBrief) {
      if (!input.messages.some(message => message.role === 'tool')) return toolsResponse([tool('supervise-worker', 'delegate_task', { task: workerBrief })]);
      if (hasUser(input.messages, '[Runtime event; source=child]')) return finish('Worker outcome received');
      return toolsResponse([tool('supervisor-wait', 'wait_for_tasks')]);
    }
    return step ? step(input) : finish('Fixture answer');
  } };
  let runtime;
  const start = (overrides = {}) => { runtime = createTaskRuntime({ dataDir, model, plugins, load: () => ({ state }), concurrency: 2, ...extra, ...overrides }); return runtime; };
  start();
  t.after(async () => { try { if (runtime) await runtime.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const create = (text, requestId = text, additional = {}) => runtime.create({ ...scope, text, requestId, model: modelName, pluginIds: plugins.list().map(plugin => plugin.id), ...additional });
  const get = id => runtime.get(id, scope);
  const wait = (id, status = 'succeeded') => poll(() => get(id), detail => detail.task.status === status, `${id} ${status}`);
  async function createWorker(text, requestId = text, additional = {}) {
    const coordinator = 'Supervise fixture worker: ' + requestId;
    supervisedBriefs.set(coordinator, text);
    const parent = await create(coordinator, requestId, additional);
    const detail = await poll(() => get(parent.id), value => value.children.length === 1, 'worker creation');
    return detail.children[0];
  }
  async function reopen(overrides = {}) { await runtime.close(); runtime = undefined; return start(overrides); }
  return { get runtime() { return runtime; }, create, createWorker, get, wait, reopen, calls, state, dataDir };
}

test('input arriving during a model step is consumed by a later step exactly once', options, async t => {
  const first = gate();
  const h = await harness(t, { step: async ({ messages, signal }) => hasUser(messages, 'Only include the latest month') ? finish('Latest month only') : held(signal, first) });
  const task = await h.create('Investigate the data', 'inflight');
  await poll(() => h.calls.length, n => n === 1, 'first model step');
  const update = { ...scope, text: 'Only include the latest month', requestId: 'update-once' };
  await h.runtime.input(task.id, update);
  await h.runtime.input(task.id, update);
  await assert.rejects(async () => h.runtime.input(task.id, { ...update, text: 'A conflicting update' }), /conflict|different|request/i);
  first.resolve(finish('Old provisional answer'));
  const result = await h.wait(task.id);
  assert.equal(result.task.output, 'Latest month only');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].messages.some(message => String(message.content).includes(update.text)), false, 'an in-flight model snapshot must not be mutated');
  assert.equal(h.calls[1].messages.filter(message => message.role === 'user' && String(message.content).includes(update.text)).length, 1);
});

test('a correction during a model call cancels its obsolete tool batch before any execution', options, async t => {
  const response = gate(), correction = 'Use the corrected plan without the old lookup or write';
  let modelStarted = false, nextMessages, reads = 0, writes = 0;
  const plugins = registry({
    obsolete_read: { execute: async () => { reads++; return { record: 'obsolete' }; } },
    obsolete_write: { effect: 'write', replay: 'manual', execute: async () => { writes++; return { written: true }; } },
  });
  const h = await harness(t, { plugins, step: ({ messages, signal }) => {
    if (hasUser(messages, correction)) { nextMessages = messages; return finish('Reconsidered the corrected plan'); }
    modelStarted = true;
    return held(signal, response);
  } });
  const task = await h.createWorker('Prepare the original plan', 'correction-during-model');
  await poll(() => modelStarted, Boolean, 'worker model call');
  await h.runtime.input(task.id, { ...scope, text: correction, requestId: 'replace-inflight-plan' });
  response.resolve(toolsResponse([tool('obsolete-read', 'obsolete_read'), tool('obsolete-write', 'obsolete_write')]));
  const completed = await h.wait(task.id);
  assert.equal(completed.task.output, 'Reconsidered the corrected plan');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(completed.task.approvals.length, 0, 'an obsolete write must not leave the correction waiting for approval');
  const assistantIndex = nextMessages.findIndex(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'obsolete-read'));
  const correctionIndex = nextMessages.findIndex(message => message.role === 'user' && message.content === correction);
  assert.ok(assistantIndex >= 0);
  for (const callId of ['obsolete-read', 'obsolete-write']) {
    const replies = nextMessages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'tool' && message.tool_call_id === callId);
    assert.equal(replies.length, 1, `${callId} must have exactly one paired response`);
    assert.equal(JSON.parse(replies[0].message.content).status, 'cancelled');
    assert.ok(assistantIndex < replies[0].index && replies[0].index < correctionIndex, 'the old tool group must be complete before the new user instruction');
  }
});

test('a correction during an async tool retains its result and cancels remaining effects', options, async t => {
  const readResult = gate(), correction = 'Keep the existing evidence and cancel the planned write';
  let readStarted = false, nextMessages, reads = 0, writes = 0;
  const plugins = registry({
    first_read: { execute: async (_args, { signal }) => { reads++; readStarted = true; return held(signal, readResult); } },
    obsolete_write: { effect: 'write', replay: 'manual', execute: async () => { writes++; return { written: true }; } },
  });
  const h = await harness(t, { plugins, step: ({ messages }) => {
    if (hasUser(messages, correction)) { nextMessages = messages; return finish('Kept the evidence without writing'); }
    return toolsResponse([tool('completed-read', 'first_read'), tool('unstarted-write', 'obsolete_write')]);
  } });
  const task = await h.createWorker('Read evidence and propose a write', 'correction-during-tool');
  await poll(() => readStarted, Boolean, 'first asynchronous plugin call');
  await h.runtime.input(task.id, { ...scope, text: correction, requestId: 'retain-evidence' });
  readResult.resolve({ receipt: 'confirmed-evidence' });
  const completed = await h.wait(task.id);
  assert.equal(completed.task.output, 'Kept the evidence without writing');
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal(completed.task.approvals.length, 0);
  const assistantIndex = nextMessages.findIndex(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'completed-read'));
  const correctionIndex = nextMessages.findIndex(message => message.role === 'user' && message.content === correction);
  assert.ok(assistantIndex >= 0);
  for (const callId of ['completed-read', 'unstarted-write']) {
    const replies = nextMessages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'tool' && message.tool_call_id === callId);
    assert.equal(replies.length, 1, `${callId} must have exactly one paired response`);
    assert.ok(assistantIndex < replies[0].index && replies[0].index < correctionIndex, 'completed and cancelled observations must precede the correction');
    if (callId === 'completed-read') assert.deepEqual(JSON.parse(replies[0].message.content), { receipt: 'confirmed-evidence' });
    else assert.equal(JSON.parse(replies[0].message.content).status, 'cancelled');
  }
});

test('a waiting worker releases its slot and retains completed tool results across reopen', options, async t => {
  let executions = 0;
  const plugins = registry({ lookup_record: { execute: async () => { executions++; return { record: 'persisted-evidence-42' }; } } });
  const h = await harness(t, { plugins, concurrency: 1, step: async ({ messages }) => {
    if (firstUser(messages).includes('Independent question')) return finish('Independent answer');
    if (hasUser(messages, 'Continue from the evidence')) {
      assert.ok(hasTool(messages, 'persisted-evidence-42'));
      return finish('Used the saved evidence');
    }
    return hasTool(messages, 'persisted-evidence-42')
      ? toolsResponse([tool('ask-once', 'request_user_input', { question: 'Should I continue?' })])
      : toolsResponse([tool('lookup-once', 'lookup_record')]);
  } });
  const waiting = await h.createWorker('Gather evidence and ask me', 'checkpoint');
  await h.wait(waiting.id, 'waiting_input');
  const another = await h.createWorker('Independent question', 'independent');
  await h.wait(another.id);
  assert.equal(executions, 1);
  await h.reopen();
  assert.equal(h.get(waiting.id).task.status, 'waiting_input');
  await h.runtime.input(waiting.id, { ...scope, text: 'Continue from the evidence', requestId: 'continue' });
  assert.equal((await h.wait(waiting.id)).task.output, 'Used the saved evidence');
  assert.equal(executions, 1, 'completed effects must not execute again to reconstruct model context');
});

test('the router stays responsive with full worker slots and child completion resumes its parent once', options, async t => {
  const workers = gate();
  let parentSteps = 0, runningWorkers = 0, maxWorkers = 0;
  const h = await harness(t, { concurrency: 2, step: async ({ messages, signal }) => {
    const brief = firstUser(messages);
    if (brief.includes('worker-A') || brief.includes('worker-B')) {
      runningWorkers++; maxWorkers = Math.max(maxWorkers, runningWorkers);
      try { await held(signal, workers); return finish(brief.includes('worker-A') ? 'Result-A' : 'Result-B'); }
      finally { runningWorkers--; }
    }
    if (brief.includes('Quick separate request')) return finish('Still responsive');
    parentSteps++;
    if (parentSteps === 1) return toolsResponse([tool('delegate-a', 'delegate_task', { task: 'worker-A' }), tool('delegate-b', 'delegate_task', { task: 'worker-B' })]);
    if (parentSteps === 2) return toolsResponse([tool('wait-children', 'wait_for_tasks')]);
    return finish('Collected both worker results');
  } });
  const parent = await h.create('Coordinate two independent jobs', 'parallel');
  await poll(() => runningWorkers, n => n === 2, 'two running workers');
  await h.wait(parent.id, 'waiting_children');
  const quick = await h.create('Quick separate request', 'quick');
  assert.equal((await h.wait(quick.id)).task.output, 'Still responsive');
  workers.resolve();
  const finished = await h.wait(parent.id);
  assert.equal(maxWorkers, 2);
  assert.equal(finished.children.length, 2);
  assert.ok(finished.children.every(child => child.status === 'succeeded'));
  assert.equal(parentSteps, 3, 'a terminal notification must cause one parent continuation after the children finish');
  await h.reopen();
  assert.equal(h.get(parent.id).task.status, 'succeeded');
  assert.equal(parentSteps, 3, 'recovery must not replay acknowledged child completions');
});

test('manual plugin approval releases capacity and denial never executes the side effect', options, async t => {
  let effects = 0;
  const plugins = registry({ write_record: { effect: 'write', replay: 'manual', execute: async () => { effects++; return { written: true }; } } });
  const h = await harness(t, { plugins, concurrency: 1, step: async ({ messages }) => {
    if (firstUser(messages).includes('Quick task')) return finish('Quick completed');
    if (messages.some(message => message.role === 'tool')) return finish('Handled the user decision');
    return toolsResponse([tool('write-once', 'write_record')]);
  } });
  const task = await h.createWorker('Propose a write', 'manual-denial');
  const waiting = await h.wait(task.id, 'waiting_approval');
  assert.equal(effects, 0);
  const independent = await h.createWorker('Quick task', 'manual-independent');
  await h.wait(independent.id);
  assert.equal(waiting.task.approvals.length, 1);
  const effectId = waiting.task.approvals[0].id;
  await h.runtime.decide(task.id, effectId, { ...scope, decision: 'deny' });
  await h.runtime.decide(task.id, effectId, { ...scope, decision: 'deny' });
  await h.wait(task.id);
  assert.equal(effects, 0);
});

test('exact approval is idempotent and scoped to the owning workspace', options, async t => {
  let effects = 0;
  const plugins = registry({ write_record: { effect: 'write', replay: 'manual', execute: async () => { effects++; return { receipt: 'write-once' }; } } });
  const h = await harness(t, { plugins, step: async ({ messages }) => hasTool(messages, 'write-once') ? finish('Write confirmed') : toolsResponse([tool('write', 'write_record')]) });
  const task = await h.createWorker('Write after approval', 'manual-approval');
  const waiting = await h.wait(task.id, 'waiting_approval'), effectId = waiting.task.approvals[0].id;
  await assert.rejects(async () => h.runtime.decide(task.id, effectId, { workspaceId: 'foreign', decision: 'approve' }), /workspace|found|scope/i);
  assert.equal(effects, 0);
  await Promise.all([h.runtime.decide(task.id, effectId, { ...scope, decision: 'approve' }), h.runtime.decide(task.id, effectId, { ...scope, decision: 'approve' })]);
  await h.wait(task.id);
  assert.equal(effects, 1);
  await h.reopen();
  assert.equal(h.get(task.id).task.status, 'succeeded');
  assert.equal(effects, 1);
});

test('a correction while awaiting approval supersedes every unexecuted call in that batch', options, async t => {
  let executed = 0;
  const plugins = registry({ write_record: { effect: 'write', replay: 'manual', execute: async () => { executed++; return { written: true }; } } });
  const h = await harness(t, { plugins, step: ({ messages }) => hasUser(messages, 'Drop both writes')
    ? finish('Reconsidered without writing')
    : toolsResponse([tool('first-write', 'write_record'), tool('second-write', 'write_record')]) });
  const task = await h.createWorker('Propose two writes', 'superseded-batch');
  await h.wait(task.id, 'waiting_approval');
  await h.runtime.input(task.id, { ...scope, text: 'Drop both writes and reconsider', requestId: 'change-direction' });
  const completed = await h.wait(task.id);
  assert.equal(completed.task.output, 'Reconsidered without writing');
  assert.equal(executed, 0);
  assert.equal(completed.task.approvals.length, 0);
});

test('request_user_input stops the rest of its tool batch until the model can reconsider', options, async t => {
  let executions = 0;
  const plugins = registry({ lookup_record: { execute: async () => { executions++; return { record: 'should-not-run' }; } } });
  const h = await harness(t, { plugins, step: ({ messages }) => hasUser(messages, 'Do not run the lookup')
    ? finish('Skipped the old lookup')
    : toolsResponse([tool('question-first', 'request_user_input', { question: 'May I continue?' }), tool('old-lookup', 'lookup_record')]) });
  const task = await h.createWorker('Ask before continuing', 'yield-batch');
  await h.wait(task.id, 'waiting_input');
  assert.equal(executions, 0, 'a blocking question cannot be followed by unreviewed effects from the same batch');
  await h.runtime.input(task.id, { ...scope, text: 'Do not run the lookup', requestId: 'skip-lookup' });
  assert.equal((await h.wait(task.id)).task.output, 'Skipped the old lookup');
  assert.equal(executions, 0);
});

test('a stricter plugin approval policy is rechecked between saved intent and execution', options, async t => {
  let executions = 0, metadataReads = 0;
  const initial = registry({ write_record: { effect: 'write', replay: 'manual', approvalRequired: false, execute: async () => { executions++; return { receipt: 'updated-policy-write' }; } } });
  const plugins = { ...initial, bind(context) {
    const binding = initial.bind(context);
    return { ...binding, metadata(name) {
      const meta = binding.metadata(name);
      if (!meta) return meta;
      metadataReads++;
      return { ...meta, approvalRequired: metadataReads > 1 };
    } };
  } };
  const h = await harness(t, { plugins, step: ({ messages }) => hasTool(messages, 'updated-policy-write')
    ? finish('Used the stricter policy')
    : toolsResponse([tool('policy-write', 'write_record')]) });
  const task = await h.createWorker('Write with current plugin policy', 'policy-change');
  const waiting = await h.wait(task.id, 'waiting_approval');
  assert.equal(executions, 0);
  await h.runtime.decide(task.id, waiting.task.approvals[0].id, { ...scope, decision: 'approve' });
  await h.wait(task.id);
  assert.equal(executions, 1);
});

for (const blockedState of ['waiting_approval', 'blocked']) test(`a router correction resumes a ${blockedState} child and supersedes its old action`, options, async t => {
  let executions = 0;
  const plugins = registry({ proposed_write: {
    effect: 'write', replay: 'manual', approvalRequired: blockedState === 'waiting_approval',
    execute: async () => { executions++; throw Error('The effect result cannot be confirmed'); },
  } });
  const h = await harness(t, { plugins, step: ({ messages, tools }) => {
    if (tools.some(definition => definition.function.name === 'delegate_task')) {
      const delegated = messages.filter(message => message.role === 'tool').map(message => { try { return JSON.parse(message.content); } catch { return {}; } }).find(result => result.task?.parentTaskId);
      if (!delegated) return toolsResponse([tool('dispatch-correction-worker', 'delegate_task', { task: 'A worker awaiting a correction' })]);
      if (hasUser(messages, 'Tell the child to stop writing') && !messages.some(message => message.tool_calls?.some(call => call.function.name === 'send_task_input'))) {
        return toolsResponse([tool('forward-correction', 'send_task_input', { taskId: delegated.task.id, text: 'Do not write. Reconsider using the known state.' })]);
      }
      if (hasUser(messages, '[Runtime event; source=child]')) return finish('The correction reached the child');
      return toolsResponse([tool('wait-corrected-worker', 'wait_for_tasks')]);
    }
    if (hasUser(messages, 'Do not write. Reconsider')) {
      assert.ok(hasTool(messages, blockedState === 'blocked' ? 'unknown' : 'cancelled'));
      return finish('Child followed the correction');
    }
    return toolsResponse([tool('proposed-action', 'proposed_write')]);
  } });
  const parent = await h.create('Route corrections to my worker', 'parent-correction-' + blockedState);
  const detail = await poll(() => h.get(parent.id), value => value.children.length === 1 && value.children[0].status === blockedState, 'child needing a correction');
  const child = detail.children[0];
  await h.runtime.input(parent.id, { ...scope, text: 'Tell the child to stop writing and reconsider', requestId: 'forward-change' });
  const finished = await h.wait(child.id);
  assert.equal(finished.task.output, 'Child followed the correction');
  assert.equal(finished.task.approvals.length, 0);
  assert.equal(finished.inputs.filter(input => input.source === 'parent').length, 1);
  assert.equal(executions, blockedState === 'blocked' ? 1 : 0, 'a correction must not replay a write');
  await h.wait(parent.id);
});

test('paged child results retain their paging fields even when the child goal is long', options, async t => {
  const longGoal = 'Read the detailed brief: ' + 'x'.repeat(15500), output = '0123456789'.repeat(4000);
  let inspected = false;
  const h = await harness(t, { step: ({ messages, tools }) => {
    if (!tools.some(definition => definition.function.name === 'delegate_task')) return finish(output);
    const results = messages.filter(message => message.role === 'tool').map(message => { try { return JSON.parse(message.content); } catch { return {}; } });
    const delegated = results.find(result => result.task?.parentTaskId);
    if (!delegated) return toolsResponse([tool('delegate-long', 'delegate_task', { task: longGoal })]);
    const page = results.find(result => result.offset !== undefined);
    if (page) {
      assert.equal(page.offset, 12000);
      assert.equal(page.nextOffset, 24000);
      assert.equal(page.total, output.length);
      assert.equal(page.hasMore, true);
      assert.equal(page.task.output, output.slice(12000, 24000));
      inspected = true;
      return finish('Read the requested page');
    }
    if (hasUser(messages, '[Runtime event; source=child]')) return toolsResponse([tool('read-page', 'read_task_result', { taskId: delegated.task.id, offset: 12000, limit: 12000 })]);
    return toolsResponse([tool('wait-long', 'wait_for_tasks')]);
  } });
  const task = await h.create('Inspect a long child result', 'paged-child');
  await h.wait(task.id);
  assert.equal(inspected, true);
});

test('an unresponsive plugin cannot hold a worker slot or block runtime shutdown after its deadline', options, async t => {
  const plugins = registry({ stalled_write: { effect: 'write', replay: 'manual', approvalRequired: false, execute: async () => new Promise(() => {}) } });
  const h = await harness(t, { plugins, concurrency: 1, stepTimeoutMs: 50, step: ({ messages }) => {
    if (firstUser(messages).includes('Independent deadline check')) return finish('The worker slot is free');
    return toolsResponse([tool('stalled-effect', 'stalled_write')]);
  } });
  const blocked = await h.createWorker('Run an unresponsive plugin', 'plugin-deadline');
  await h.wait(blocked.id, 'blocked');
  const other = await h.createWorker('Independent deadline check', 'deadline-next-task');
  assert.equal((await h.wait(other.id)).task.output, 'The worker slot is free');
  await h.runtime.close();
});

test('cancelling a parent aborts running and queued descendants without admitting more work', options, async t => {
  const blocker = gate();
  let calls = 0, aborted = 0;
  const h = await harness(t, { concurrency: 1, step: async ({ messages, signal }) => {
    if (firstUser(messages).includes('child-job')) {
      calls++;
      try { return await held(signal, blocker); }
      catch (error) { if (signal.aborted) aborted++; throw error; }
    }
    if (messages.some(message => message.role === 'tool')) return toolsResponse([tool('waiting', 'wait_for_tasks')]);
    return toolsResponse([tool('first', 'delegate_task', { task: 'child-job-1' }), tool('second', 'delegate_task', { task: 'child-job-2' })]);
  } });
  const parent = await h.create('Run and then cancel children', 'cancellation');
  await poll(() => h.get(parent.id), detail => detail.children.length === 2 && calls === 1, 'one running and one queued child');
  await h.runtime.cancel(parent.id, scope);
  await h.wait(parent.id, 'cancelled');
  await poll(() => h.get(parent.id).children, children => children.every(child => child.status === 'cancelled'), 'cancelled descendants');
  assert.equal(calls, 1, 'queued descendant must never enter the model');
  assert.equal(aborted, 1);
  await h.reopen();
  assert.equal(h.get(parent.id).task.status, 'cancelled');
  assert.equal(calls, 1);
});

test('cancelling the same child repeatedly does not redeliver its completion or restart its finished parent', options, async t => {
  const blocker = gate();
  const h = await harness(t, { step: ({ signal }) => held(signal, blocker) });
  const child = await h.createWorker('A child to cancel once', 'cancel-once');
  await h.wait(child.id, 'running');
  await h.runtime.cancel(child.id, scope);
  await h.runtime.cancel(child.id, scope);
  const parent = await h.wait(child.parentTaskId);
  assert.equal(parent.inputs.filter(input => input.source === 'child').length, 1, 'one terminal transition produces one parent input');
  await h.runtime.cancel(child.id, scope);
  assert.equal(h.get(child.parentTaskId).task.status, 'succeeded', 'an idempotent cancellation must not restart completed work');
  assert.equal(h.get(child.parentTaskId).inputs.filter(input => input.source === 'child').length, 1);
});

test('prompt edits use revisions and persist while existing tasks retain their initial prompt snapshot', options, async t => {
  const h = await harness(t, { step: ({ messages }) => {
    if (firstUser(messages).includes('Second prompt task') || hasUser(messages, 'Finish the original task')) return finish('Prompt checked');
    return toolsResponse([tool('prompt-question', 'request_user_input', { question: 'Continue?' })]);
  } });
  const original = h.runtime.config(scope).prompts.find(prompt => prompt.role === 'router');
  const first = h.runtime.savePrompt('router', { ...scope, content: 'CUSTOM_PROMPT_VERSION_ONE', revision: original.revision });
  const task = await h.create('First prompt task', 'prompt-one');
  await h.wait(task.id, 'waiting_input');
  const second = h.runtime.savePrompt('router', { ...scope, content: 'CUSTOM_PROMPT_VERSION_TWO', revision: first.revision });
  await assert.rejects(async () => h.runtime.savePrompt('router', { ...scope, content: 'STALE_PROMPT', revision: first.revision }), /changed|revision|version/i);
  await h.reopen();
  assert.equal(h.runtime.config(scope).prompts.find(prompt => prompt.role === 'router').content, second.content);
  await h.runtime.input(task.id, { ...scope, text: 'Finish the original task', requestId: 'prompt-followup' });
  const finished = await h.wait(task.id);
  assert.equal(finished.task.promptVersion, first.version);
  const continued = h.calls.findLast(call => firstUser(call.messages) === 'First prompt task');
  assert.match(continued.messages[0].content, /CUSTOM_PROMPT_VERSION_ONE/);
  assert.doesNotMatch(continued.messages[0].content, /CUSTOM_PROMPT_VERSION_TWO/);
  const fresh = await h.create('Second prompt task', 'prompt-two');
  assert.equal((await h.wait(fresh.id)).task.promptVersion, second.version);
  assert.match(h.calls.at(-1).messages[0].content, /CUSTOM_PROMPT_VERSION_TWO/);
  const restored = h.runtime.savePrompt('router', { ...scope, content: null, revision: second.revision });
  assert.equal(restored.content, original.defaultContent);
  assert.equal(restored.version, original.version);
});

test('a model cannot invoke an unbound plugin or enlarge a child capability grant', options, async t => {
  let effects = 0, turns = 0;
  const h = await harness(t, { plugins: registry({ hidden_write: { effect: 'write', replay: 'manual', execute: async () => { effects++; return {}; } } }), step: async ({ messages }) => {
    turns++;
    if (turns === 1) return toolsResponse([tool('unbound', 'hidden_write'), tool('escalate', 'delegate_task', { task: 'Attempt escalation', pluginIds: ['fixture'] })]);
    assert.ok(messages.some(message => message.role === 'tool'));
    return finish('Unavailable tools rejected');
  } });
  const task = await h.create('Use no plugins', 'least-capability', { pluginIds: [] });
  const result = await h.wait(task.id);
  assert.equal(effects, 0);
  assert.equal(result.children.length, 0);
});

// Run a real child process and stop it while a plugin is in progress. A graceful
// close would exercise a different path and could conceal missing crash recovery.
async function crashFixture(t, effect) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'task-crash-'));
  const marker = path.join(dataDir, 'effects.txt');
  let child, recovered;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); try { if (recovered) await recovered.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const source = `
    import { createTaskRuntime } from ${JSON.stringify(new URL('./task-runtime.mjs', import.meta.url).href)};
    import { emptyState } from ${JSON.stringify(new URL('./validation.mjs', import.meta.url).href)};
    import { appendFileSync } from 'node:fs';
    const dataDir=${JSON.stringify(dataDir)}, marker=${JSON.stringify(marker)}, effect=${JSON.stringify(effect)};
    const scope={workspaceId:'personal'};
    const plugins={list:()=>[{id:'fixture',name:'Fixture',available:true,configured:true,defaultEnabled:true}],bind:({taskId})=>({
      definitions:()=>[{type:'function',function:{name:'fixture_effect',description:'Test only',parameters:{type:'object',properties:{},additionalProperties:false}}}],
      metadata:()=>({pluginId:'fixture',effect,replay:effect==='write'?'manual':'safe',approvalRequired:effect==='write'}),
      execute:async()=>{appendFileSync(marker,'effect\\n');process.send({type:'executing',id:taskId});return new Promise(()=>{});}
    })};
    const call=(id,name,args={})=>({text:'',toolCalls:[{id,name,arguments:args}]});
    const model={configured:true,models:['test-model'],step:async({messages})=>{
      if(messages.find(m=>m.role==='user')?.content==='Crash supervisor'){
        return messages.some(m=>m.role==='tool')?call('wait','wait_for_tasks'):call('delegate','delegate_task',{task:'Crash recovery task'});
      }
      return call('effect-once','fixture_effect');
    }};
    const runtime=createTaskRuntime({dataDir,model,plugins,load:()=>({state:emptyState()})});
    const task=await runtime.create({...scope,text:'Crash supervisor',requestId:'crash-request',model:'test-model',pluginIds:['fixture']});
    process.send({type:'created',id:task.id});
    if(effect==='write'){
      const timer=setInterval(()=>{const info=runtime.get(task.id,scope).children[0];if(info?.status==='waiting_approval'){clearInterval(timer);runtime.decide(info.id,info.approvals[0].id,{...scope,decision:'approve'});}},5);
    }
    setInterval(()=>{},1000);
  `;
  child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errorOutput = '';
  child.stderr.on('data', bytes => { errorOutput += bytes.toString(); });
  const executing = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Crash fixture did not start an effect: ' + errorOutput)), 5000);
    child.on('message', message => { if (message.type === 'executing') { clearTimeout(timeout); resolve(message.id); } });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => { if (code || signal) { clearTimeout(timeout); reject(Error(`Crash fixture exited ${code}/${signal}: ${errorOutput}`)); } });
  });
  const id = await executing;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
  let recoveredEffects = 0;
  const plugins = registry({ fixture_effect: { effect, replay: effect === 'write' ? 'manual' : 'safe', execute: async () => { recoveredEffects++; return { receipt: 'recovered-result' }; } } });
  const model = { configured: true, models: [modelName], step: async ({ messages }) => {
    if (effect === 'read-only' && firstUser(messages) === 'Crash recovery task') assert.ok(hasTool(messages, 'recovered-result'));
    return finish('Recovered task finished');
  } };
  recovered = createTaskRuntime({ dataDir, model, plugins, load: () => ({ state: emptyState() }) });
  return { id, get: () => recovered.get(id, scope), runtime: recovered, marker, executions: () => recoveredEffects };
}

test('a hard crash replays an unfinished safe read and resumes from its persisted tool intent', options, async t => {
  const h = await crashFixture(t, 'read-only');
  const finished = await poll(h.get, detail => detail.task.status === 'succeeded', 'safe-read recovery');
  assert.equal(finished.task.output, 'Recovered task finished');
  assert.equal(h.executions(), 1);
  assert.equal(await readFile(h.marker, 'utf8'), 'effect\n');
});

test('a hard crash during a manual write blocks uncertain effects and retry does not repeat the write', options, async t => {
  const h = await crashFixture(t, 'write');
  await poll(h.get, detail => detail.task.status === 'blocked', 'uncertain-write recovery');
  assert.equal(h.executions(), 0);
  await assert.rejects(async () => h.runtime.retry(h.id, scope), /unknown|uncertain|check|input|effect/i);
  assert.equal(h.executions(), 0);
  assert.equal(await readFile(h.marker, 'utf8'), 'effect\n');
});

test('a future task schema is rejected without altering its database or retaining a lock', options, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'task-future-schema-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'tasks.sqlite'), db = new DatabaseSync(file);
  db.exec("CREATE TABLE task_schema(version INTEGER PRIMARY KEY); INSERT INTO task_schema VALUES (2); CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserve me');");
  db.close();
  const before = await readFile(file);
  assert.throws(() => createTaskRuntime({ dataDir, model: { configured: false, models: [modelName] }, plugins: registry(), load: () => ({ state: emptyState() }) }), /schema|version/i);
  assert.deepEqual(await readFile(file), before);
  assert.equal(existsSync(path.join(dataDir, 'tasks.lock')), false);
});

test('corrupt task storage fails cleanly on successive starts without leaving a live runtime lock', options, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'task-corrupt-schema-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'tasks.sqlite'), content = 'This file is not a SQLite database.';
  await writeFile(file, content);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => createTaskRuntime({ dataDir, model: { configured: false, models: [modelName] }, plugins: registry(), load: () => ({ state: emptyState() }) }), error => {
      assert.match(error.message, /database|sqlite|schema|file/i);
      assert.doesNotMatch(error.message, /Another task scheduler/);
      return true;
    });
    assert.equal(existsSync(path.join(dataDir, 'tasks.lock')), false);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('two processes racing to replace stale scheduler metadata admit one owner and preserve its lock', options, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'task-concurrent-owner-'));
  const contenders = [];
  let reopened;
  t.after(async () => {
    await Promise.all(contenders.map(({ process: child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
    }));
    try { if (reopened) await reopened.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  await writeFile(path.join(dataDir, 'tasks.lock'), JSON.stringify({ pid: 2147483647, token: 'stale-test-owner' }));
  const source = `
    import { createTaskRuntime } from ${JSON.stringify(new URL('./task-runtime.mjs', import.meta.url).href)};
    import { emptyState } from ${JSON.stringify(new URL('./validation.mjs', import.meta.url).href)};
    let runtime;
    process.on('message', async message => {
      if(message.type==='start') {
        try {
          runtime=createTaskRuntime({dataDir:${JSON.stringify(dataDir)},model:{configured:false,models:['test-model']},plugins:{list:()=>[],bind:()=>({definitions:()=>[]})},load:()=>({state:emptyState()})});
          process.send({type:'started',pid:process.pid});
        } catch(error) { process.send({type:'rejected',pid:process.pid,message:error.message}); }
      }
      if(message.type==='stop') {
        if(runtime) await runtime.close();
        process.send({type:'stopped',pid:process.pid},()=>process.exit(0));
      }
    });
    process.send({type:'ready',pid:process.pid});
  `;
  for (let i = 0; i < 2; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const contender = { process: child, messages: [], errors: '' };
    child.on('message', message => contender.messages.push(message));
    child.stderr.on('data', bytes => { contender.errors += bytes.toString(); });
    contenders.push(contender);
  }
  await Promise.all(contenders.map(contender => poll(() => contender.messages.some(message => message.type === 'ready'), Boolean, 'contender ready')));
  // Both modules are loaded before either process is released to acquire ownership.
  contenders.forEach(contender => contender.process.send({ type: 'start' }));
  const outcomes = await Promise.all(contenders.map(contender => poll(() => contender.messages.find(message => ['started', 'rejected'].includes(message.type)), Boolean, 'startup ownership outcome')));
  assert.equal(outcomes.filter(outcome => outcome.type === 'started').length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter(outcome => outcome.type === 'rejected').length, 1, JSON.stringify(outcomes));
  const winner = contenders[outcomes.findIndex(outcome => outcome.type === 'started')];
  const loser = contenders[outcomes.findIndex(outcome => outcome.type === 'rejected')];
  const metadata = JSON.parse(await readFile(path.join(dataDir, 'tasks.lock'), 'utf8'));
  assert.equal(metadata.pid, winner.process.pid);
  assert.notEqual(metadata.token, 'stale-test-owner');
  loser.process.send({ type: 'stop' });
  await poll(() => loser.messages.some(message => message.type === 'stopped'), Boolean, 'rejected contender shutdown');
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'tasks.lock'), 'utf8')), metadata, 'a rejected process must not remove or replace the owner metadata');
  winner.process.send({ type: 'stop' });
  await poll(() => winner.messages.some(message => message.type === 'stopped'), Boolean, 'owner shutdown');
  assert.equal(existsSync(path.join(dataDir, 'tasks.lock')), false);
  reopened = createTaskRuntime({ dataDir, model: { configured: false, models: [modelName] }, plugins: registry(), load: () => ({ state: emptyState() }) });
  assert.deepEqual(reopened.list(scope), [], 'ownership must be available again after the winner closes');
});
