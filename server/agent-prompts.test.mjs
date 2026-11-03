import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BUILTIN_PROMPTS, assembleAgentPrompt } from './agent-prompts.mjs';

test('built-in role prompts have stable content hashes and executable coordination guidance', () => {
  assert.deepEqual(Object.keys(BUILTIN_PROMPTS), ['router', 'worker', 'recovery']);
  for (const [role, entry] of Object.entries(BUILTIN_PROMPTS)) {
    assert.equal(entry.role, role);
    assert.equal(entry.version, createHash('sha256').update(entry.content).digest('hex'));
    assert.ok(Object.isFrozen(entry));
  }
  for (const name of ['delegate_task', 'send_task_input', 'list_task_children', 'read_task_result', 'wait_for_tasks', 'request_user_input']) assert.ok(BUILTIN_PROMPTS.router.content.includes(name));
  assert.match(BUILTIN_PROMPTS.worker.content, /user's language/);
});

test('full prompt override replaces the editable role text while keeping runtime facts and task context', () => {
  const prompt = assembleAgentPrompt({ role: 'worker', override: '请用中文完成任务。', goal: '比较两篇论文', agent: { name: 'Researcher', prompt: '核对引用来源。' }, plugins: [{ id: 'web-search', name: 'Search', available: true, description: 'Search public sources.' }] });
  assert.ok(prompt.startsWith('请用中文完成任务。'));
  assert.ok(!prompt.includes('# Task worker'));
  assert.match(prompt, /Only the supplied tool definitions/);
  assert.ok(prompt.includes('比较两篇论文') && prompt.includes('核对引用来源。'));
  assert.match(prompt, /web-search/);
  assert.ok(assembleAgentPrompt({ role: 'worker', override: null }).startsWith(BUILTIN_PROMPTS.worker.content));
});

test('recovery guidance uses recorded state without treating interrupted writes as success', () => {
  const prompt = assembleAgentPrompt({ role: 'router', goal: 'finish', recovery: 'One child finished; the second is pending.' });
  assert.ok(prompt.includes(BUILTIN_PROMPTS.recovery.content));
  assert.match(prompt, /One child finished/);
  assert.throws(() => assembleAgentPrompt({ role: 'made-up' }), /Unknown/);
  assert.throws(() => assembleAgentPrompt({ role: 'worker', override: 'x'.repeat(16001) }), /override/);
});
