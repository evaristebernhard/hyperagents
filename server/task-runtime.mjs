import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync, openSync, closeSync, unlinkSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from './validation.mjs';
import { validateToolArguments, toolResultOutcome } from './tool-registry.mjs';
import { BUILTIN_PROMPTS, assembleAgentPrompt } from './agent-prompts.mjs';

const stamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const fail = (status, message) => { throw new ApiError(status, message, 'TASK_RUNTIME'); };
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error('Operation interrupted.'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const bounded = (value, max = 24000) => {
  const text = JSON.stringify(value ?? null);
  return text.length <= max ? text : JSON.stringify({ truncated: true, excerpt: text.slice(0, max), notice: 'Output exceeded the excerpt limit. Use a narrower query or a paging tool for more detail.' });
};
const definition = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const textSchema = { type: 'string', minLength: 1, maxLength: 16000 };
const idSchema = { type: 'string', minLength: 1, maxLength: 200 };
const controlTools = [
  definition('delegate_task', 'Start an independent worker for a self-contained subtask. Include all constraints and expected output. Repeating an identical brief and capability selection reuses that child.', { task: textSchema, agentId: idSchema, pluginIds: { type: 'array', maxItems: 30, items: idSchema } }, ['task']),
  definition('send_task_input', 'Send a correction or new fact to a direct child. Its existing goal remains in effect. This does not grant additional plugins.', { taskId: idSchema, text: textSchema }, ['taskId', 'text']),
  definition('list_task_children', 'Read the actual states and bounded results of this task\'s direct workers.'),
  definition('read_task_result', 'Read a direct worker\'s saved result and pending question. Long results can be paged with offset/limit. Do not invent results while it is running.', { taskId: idSchema, offset: { type: 'integer', minimum: 0, maximum: 64000 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, ['taskId']),
  definition('wait_for_tasks', 'Yield until the current workers finish. This releases execution capacity; completion events resume the task automatically.'),
];
const questionTool = definition('request_user_input', 'Ask one concrete question when missing information blocks progress. The task waits durably and resumes when the person replies. Do not ask again for work already authorized.', { question: { type: 'string', minLength: 1, maxLength: 2000 } }, ['question']);

/** A single-process, durable task scheduler. Models and tools are injected ports.
 * SQL transactions record intent before effects. No browser or shell is built into
 * this kernel. Legacy /api/runs retains its existing lifecycle independently. */
export function createTaskRuntime({ dataDir, model, plugins, load, concurrency = 2, maxSteps = 32, maxChildren = 8, maxTools = 128, stepTimeoutMs = 120000 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw Error('Invalid task concurrency.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'tasks.sqlite'), lockFile = path.join(dataDir, 'tasks.lock'), schedulerFile = path.join(dataDir, 'tasks.scheduler.sqlite');
  for (const candidate of [file, lockFile, schedulerFile]) {
    try { if (lstatSync(candidate).isSymbolicLink()) throw Error('Task storage cannot be a symbolic link.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // An OS-backed SQLite transaction owns the scheduler, independently of task
  // checkpoints. Process death releases it without a stale-file unlink race.
  // Never unlink this database: a new inode could let two owners acquire locks.
  const lockToken = randomUUID();
  let schedulerDb, lockHeld = false;
  try {
    schedulerDb = new DatabaseSync(schedulerFile);
    schedulerDb.exec('PRAGMA busy_timeout=250; BEGIN EXCLUSIVE;');
    lockHeld = true;
    chmodSync(schedulerFile, 0o600);
  } catch (error) {
    schedulerDb?.close();
    if (error.errcode === 5 || error.errcode === 6) throw Error('Another task scheduler owns this data directory.');
    throw error;
  }
  function releaseLock() {
    if (!lockHeld) return;
    try { if (JSON.parse(readFileSync(lockFile, 'utf8')).token === lockToken) unlinkSync(lockFile); } catch { /* already removed */ }
    try { schedulerDb.exec('ROLLBACK'); } finally { lockHeld = false; schedulerDb.close(); }
  }
  // This is diagnostic metadata only. It can be replaced safely while holding
  // the exclusive database lock, even after a crash or PID reuse.
  try {
    try { unlinkSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const descriptor = openSync(lockFile, 'wx', 0o600);
    try { writeSync(descriptor, JSON.stringify({ pid: process.pid, token: lockToken })); } finally { closeSync(descriptor); }
  } catch (error) { releaseLock(); throw error; }
  let db;
  try {
    db = new DatabaseSync(file);
    // Inspect before any DDL or journal-mode change. A future or unrelated
    // database must be refused without adding our schema/version to it.
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length) {
      if (!tables.some(t => t.name === 'task_schema')) throw Error('Unrecognized task database.');
      const versions = db.prepare('SELECT version FROM task_schema').all();
      if (versions.length !== 1 || versions[0].version !== 1) throw Error('Unsupported task schema.');
    }
    chmodSync(file, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS task_schema (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO task_schema VALUES (1);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, parent_id TEXT REFERENCES tasks(id), root_id TEXT NOT NULL,
      role TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
      model TEXT NOT NULL, plugin_ids TEXT NOT NULL, agent_id TEXT, request_key TEXT, request_hash TEXT,
      messages TEXT NOT NULL, prompt_version TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', question TEXT, error TEXT,
      step_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0, step_limit INTEGER NOT NULL, tool_limit INTEGER NOT NULL DEFAULT 128,
      completion INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL,
      UNIQUE(workspace_id, request_key));
    CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status,role,created);
    CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
    CREATE TABLE IF NOT EXISTS task_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), source TEXT NOT NULL,
      request_key TEXT NOT NULL, text TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL,
      UNIQUE(task_id,source,request_key));
    CREATE TABLE IF NOT EXISTS task_events (
      task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(task_id,seq));
    CREATE TABLE IF NOT EXISTS task_effects (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), call_id TEXT NOT NULL, step INTEGER NOT NULL,
      tool TEXT NOT NULL, args TEXT NOT NULL, plugin_id TEXT, effect TEXT NOT NULL, replay TEXT NOT NULL,
      approval_required INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      result TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS effects_task ON task_effects(task_id,step,created);
    CREATE TABLE IF NOT EXISTS task_attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, created TEXT NOT NULL, finished TEXT);
    CREATE TABLE IF NOT EXISTS task_prompts (
      workspace_id TEXT NOT NULL, role TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT,
      version TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(workspace_id,role,revision));`);
  } catch (error) { try { db?.close(); } finally { releaseLock(); } throw error; }

  let closed = false, pumping = false;
  const controls = new Map();
  const raw = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const children = id => db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY created,rowid').all(id);
  const effects = id => db.prepare('SELECT * FROM task_effects WHERE task_id=? ORDER BY step,rowid').all(id);
  const pending = id => effects(id).filter(e => !['completed', 'failed', 'denied', 'cancelled'].includes(e.status));
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function event(id, type, values = {}) {
    const seq = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM task_events WHERE task_id=?').get(id).seq;
    db.prepare('INSERT INTO task_events VALUES (?,?,?)').run(id, seq, JSON.stringify({ seq, type, createdAt: stamp(), ...values }));
  }
  function workspace(workspaceId) {
    if (!identity(workspaceId)) fail(400, 'Workspace is required.');
    const result = load().state.workspaces.find(w => w.id === workspaceId);
    if (!result) fail(404, 'Workspace not found.');
    return result;
  }
  function scope(id, request) {
    workspace(request?.workspaceId);
    const task = raw(id);
    if (!task || task.workspace_id !== request.workspaceId) fail(404, 'Task not found in this workspace.');
    return task;
  }
  function selectedAgent(workspaceId, agentId) {
    const w = workspace(workspaceId);
    if (!agentId) return undefined;
    const agent = w.data.agents.find(a => a.id === agentId && !a.archived);
    if (!agent) fail(422, 'Selected agent is not available.');
    return agent;
  }
  function prompt(workspaceId, role) {
    if (!['router', 'worker'].includes(role)) fail(400, 'Unknown prompt role.');
    const builtin = BUILTIN_PROMPTS[role];
    const saved = db.prepare('SELECT * FROM task_prompts WHERE workspace_id=? AND role=? ORDER BY revision DESC LIMIT 1').get(workspaceId, role);
    const content = saved?.content ?? builtin.content;
    return { role, content, defaultContent: builtin.content, revision: saved?.revision ?? 0, version: hash(content), description: builtin.description };
  }
  function info(row) {
    return { id: row.id, workspaceId: row.workspace_id, ...(row.parent_id ? { parentTaskId: row.parent_id } : {}), rootTaskId: row.root_id,
      role: row.role, title: row.title, goal: row.goal, status: row.status, model: row.model, pluginIds: JSON.parse(row.plugin_ids),
      ...(row.agent_id ? { agentId: row.agent_id } : {}), output: row.output, ...(row.question ? { question: row.question } : {}), ...(row.error ? { error: row.error } : {}),
      createdAt: row.created, updatedAt: row.updated, stepCount: row.step_count, toolCount: row.tool_count, promptVersion: row.prompt_version,
      approvals: effects(row.id).filter(e => ['awaiting_approval', 'unknown'].includes(e.status)).map(e => ({ id: e.id, tool: e.tool, args: JSON.parse(e.args), status: e.status })) };
  }
  function setStatus(id, status, error = null) {
    const before = raw(id);
    db.prepare('UPDATE tasks SET status=?,error=?,updated=? WHERE id=?').run(status, error, stamp(), id);
    if (before.status !== status || before.error !== error) event(id, 'status', { status, ...(error ? { text: error } : {}) });
  }
  function addInput(id, text, source, key) {
    const old = db.prepare('SELECT * FROM task_inputs WHERE task_id=? AND source=? AND request_key=?').get(id, source, key);
    if (old) { if (old.text !== text) fail(409, 'This request ID was already used for different input.'); return old; }
    const result = db.prepare('INSERT INTO task_inputs (task_id,source,request_key,text,created) VALUES (?,?,?,?,?)').run(id, source, key, text, stamp());
    event(id, 'input_received', { inputId: Number(result.lastInsertRowid), source, text });
    return db.prepare('SELECT * FROM task_inputs WHERE id=?').get(result.lastInsertRowid);
  }
  const hasCorrection = id => !!db.prepare("SELECT 1 FROM task_inputs WHERE task_id=? AND consumed=0 AND source IN ('user','parent')").get(id);
  function retirePending(id) {
    for (const effect of pending(id)) {
      if (effect.status === 'unknown') finishEffect(effect, { status: 'unknown', notice: 'The prior write result was not confirmed. Inspect actual state before any new action; the original call was not replayed.' }, 'failed');
      else if (effect.status !== 'executing') finishEffect(effect, { status: 'cancelled', reason: 'Superseded by a new instruction before execution.' }, 'cancelled');
    }
  }
  // The caller owns the SQL transaction, including for kernel tool effects.
  // Corrections from a parent and the user follow the same durable transition.
  function resumeInput(id, text, source, key) {
    const old = db.prepare('SELECT * FROM task_inputs WHERE task_id=? AND source=? AND request_key=?').get(id, source, key);
    if (old) { if (old.text !== text) fail(409, 'Request ID already belongs to different input.'); return old; }
    const row = raw(id), value = addInput(id, text, source, key);
    if (['waiting_approval', 'blocked'].includes(row.status)) retirePending(id);
    if (row.status !== 'running') setStatus(id, 'queued');
    return value;
  }
  function wake(id) {
    const row = raw(id);
    if (!row || row.status === 'cancelled' || row.status === 'running' || ['waiting_approval', 'blocked'].includes(row.status)) return;
    setStatus(id, 'queued');
  }
  function notifyParent(row) {
    if (!row.parent_id) return;
    const parent = raw(row.parent_id);
    if (!parent || ['cancelled', 'failed'].includes(parent.status)) return;
    const completion = raw(row.id).completion;
    addInput(parent.id, JSON.stringify({ taskId: row.id, title: row.title, status: row.status, result: row.output.slice(0, 16000), error: row.error }), 'child', row.id + ':' + completion);
    // A partial set of children finishing should not cause repeated LLM polling.
    if (!children(parent.id).some(c => !terminal.has(c.status))) wake(parent.id);
  }
  function finish(id, status, output, error = null) {
    db.prepare('UPDATE tasks SET output=?,question=NULL,completion=completion+1,updated=? WHERE id=?').run(output, stamp(), id);
    setStatus(id, status, error); event(id, 'result', { status, text: output }); notifyParent(raw(id));
  }
  function validatePlugins(ids, inherited) {
    if (!Array.isArray(ids) || ids.length > 30 || ids.some(id => !identity(id)) || new Set(ids).size !== ids.length) fail(422, 'Invalid plugin selection.');
    const catalog = plugins.list();
    for (const id of ids) {
      if (!catalog.some(p => p.id === id && p.available)) fail(422, 'Plugin is unavailable: ' + id);
      if (inherited && !inherited.includes(id)) fail(403, 'A worker cannot gain plugins its parent did not select.');
    }
    return [...ids];
  }
  function insertTask({ workspaceId, text, pluginIds, model: modelName, agentId, parent, requestKey, requestHash }) {
    const agent = selectedAgent(workspaceId, agentId);
    const id = randomUUID(), role = parent ? 'worker' : 'router', p = prompt(workspaceId, role), created = stamp();
    const system = assembleAgentPrompt({ role, goal: text, agent: parent ? agent : undefined, plugins: plugins.list().filter(p => pluginIds.includes(p.id)), override: p.content });
    const messages = [{ role: 'system', content: system }];
    db.prepare(`INSERT INTO tasks (id,workspace_id,parent_id,root_id,role,title,goal,status,model,plugin_ids,agent_id,request_key,request_hash,messages,prompt_version,step_limit,tool_limit,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, workspaceId, parent?.id ?? null, parent?.root_id ?? id, role, text.replace(/\s+/g, ' ').slice(0, 100), text, 'queued', modelName, JSON.stringify(pluginIds), agentId ?? null, requestKey, requestHash, JSON.stringify(messages), p.version, maxSteps, maxTools, created, created);
    addInput(id, text, 'user', 'initial'); event(id, 'created', { role, parentTaskId: parent?.id ?? null });
    return raw(id);
  }
  function finishEffect(effect, result, status = 'completed') {
    const row = raw(effect.task_id), messages = JSON.parse(row.messages);
    messages.push({ role: 'tool', tool_call_id: effect.call_id, content: bounded(result) });
    db.prepare('UPDATE tasks SET messages=?,updated=? WHERE id=?').run(JSON.stringify(messages), stamp(), row.id);
    db.prepare('UPDATE task_effects SET status=?,result=?,updated=? WHERE id=?').run(status, bounded(result, 128000), stamp(), effect.id);
    event(row.id, 'tool_result', { effectId: effect.id, tool: effect.tool, status, text: bounded(result, 12000) });
  }
  function checkChild(parent, id) {
    const child = raw(id);
    if (!child || child.parent_id !== parent.id || child.workspace_id !== parent.workspace_id) fail(404, 'Direct child task not found.');
    return child;
  }
  function kernelEffect(row, effect) {
    const args = JSON.parse(effect.args), name = effect.tool;
    const def = [...(row.role === 'router' ? controlTools : []), questionTool].find(d => d.function.name === name);
    if (!def) throw Error('Control tool is not available to this role.');
    validateToolArguments(def.function.parameters, args);
    if (name === 'delegate_task') {
      const ids = validatePlugins(args.pluginIds ?? JSON.parse(row.plugin_ids), JSON.parse(row.plugin_ids));
      const agentId = args.agentId ?? row.agent_id ?? undefined;
      const key = 'child:' + row.id + ':' + hash(JSON.stringify([args.task, agentId ?? null, ids]));
      const existing = db.prepare('SELECT * FROM tasks WHERE workspace_id=? AND request_key=?').get(row.workspace_id, key);
      if (existing) return { task: info(existing), reused: true };
      if (children(row.id).length >= maxChildren) throw Error('Child task budget reached. Reuse existing workers.');
      const child = insertTask({ workspaceId: row.workspace_id, text: args.task, pluginIds: ids, model: row.model, agentId, parent: row, requestKey: key, requestHash: hash(key) });
      event(row.id, 'child_created', { childTaskId: child.id, text: child.title });
      return { task: info(child) };
    }
    if (name === 'send_task_input') {
      const child = checkChild(row, args.taskId);
      if (child.status === 'cancelled') throw Error('Cancelled workers cannot resume.');
      resumeInput(child.id, args.text, 'parent', effect.id);
      return { delivered: true, taskId: child.id, status: raw(child.id).status };
    }
    if (name === 'list_task_children') return { tasks: children(row.id).map(child => ({ id: child.id, title: child.title, status: child.status,
      output: child.output.slice(0, 1500), truncated: child.output.length > 1500, ...(child.question ? { question: child.question.slice(0, 400) } : {}), ...(child.error ? { error: child.error.slice(0, 400) } : {}) })) };
    if (name === 'read_task_result') {
      const task = info(checkChild(row, args.taskId)), offset = args.offset ?? 0, limit = args.limit ?? 12000, total = task.output.length;
      return { offset, nextOffset: Math.min(total, offset + limit), total, hasMore: offset + limit < total,
        task: { id: task.id, title: task.title, status: task.status, output: task.output.slice(offset, offset + limit), ...(task.question ? { question: task.question } : {}), ...(task.error ? { error: task.error } : {}) } };
    }
    if (name === 'wait_for_tasks') {
      const waiting = children(row.id).filter(c => !terminal.has(c.status));
      if (waiting.length) setStatus(row.id, 'waiting_children');
      return { status: waiting.length ? 'waiting_children' : 'ready', taskIds: waiting.map(c => c.id) };
    }
    db.prepare('UPDATE tasks SET question=? WHERE id=?').run(args.question, row.id);
    event(row.id, 'question', { text: args.question }); setStatus(row.id, 'waiting_input');
    return { status: 'waiting_input', question: args.question };
  }
  function consumeInputs(id) {
    const row = raw(id), messages = JSON.parse(row.messages);
    const inputs = db.prepare('SELECT * FROM task_inputs WHERE task_id=? AND consumed=0 ORDER BY id LIMIT 32').all(id);
    for (const input of inputs) {
      messages.push({ role: 'user', content: input.source === 'user' ? input.text : '[Runtime event; source=' + input.source + ']\n' + input.text });
      db.prepare('UPDATE task_inputs SET consumed=1 WHERE id=?').run(input.id);
      event(id, 'input_consumed', { inputId: input.id });
    }
    db.prepare('UPDATE tasks SET messages=?,question=NULL WHERE id=?').run(JSON.stringify(messages), id);
    return messages;
  }
  async function execute(id) {
    const controller = new AbortController(), attemptId = randomUUID();
    const control = { controller, promise: null }; controls.set(id, control);
    tx(() => { setStatus(id, 'running'); db.prepare('INSERT INTO task_attempts VALUES (?,?,?,?,NULL)').run(attemptId, id, 'running', stamp()); });
    let binding, timer;
    const run = async () => {
      try {
        let row = raw(id); selectedAgent(row.workspace_id, row.agent_id);
        binding = plugins.bind({ workspaceId: row.workspace_id, taskId: id, role: row.role, pluginIds: JSON.parse(row.plugin_ids), agentId: row.agent_id ?? undefined });
        // An assistant tool-call group is completed before new user messages enter
        // its history; a restart therefore cannot create orphan tool messages.
        for (const effect of pending(id)) {
          if (controller.signal.aborted || closed) return;
          // A response based on an older instruction may have proposed tools
          // after a correction arrived. Pair those calls with cancellations,
          // then let the model reconsider before any unstarted effect executes.
          if (hasCorrection(id)) { tx(() => retirePending(id)); break; }
          row = raw(id);
          if (effect.status === 'unknown') { tx(() => setStatus(id, 'blocked', 'A previous write has an unknown result. Check its actual outcome before continuing.')); return; }
          const current = effect.plugin_id === 'kernel' ? null : binding.metadata(effect.tool);
          if (effect.plugin_id !== 'kernel' && (!current || current.pluginId !== effect.plugin_id || current.effect !== effect.effect || current.replay !== effect.replay)) {
            tx(() => finishEffect(effect, { error: 'The plugin changed or is no longer authorized. The tool was not executed.' }, 'failed')); continue;
          }
          const needsApproval = effect.approval_required || (current && (current.approvalRequired ?? current.effect === 'write'));
          if (needsApproval && !effect.approved) {
            tx(() => { db.prepare("UPDATE task_effects SET status='awaiting_approval',approval_required=1,updated=? WHERE id=?").run(stamp(), effect.id); setStatus(id, 'waiting_approval'); event(id, 'approval', { effectId: effect.id, tool: effect.tool, args: JSON.parse(effect.args) }); });
            return;
          }
          if (effect.plugin_id === 'kernel') {
            tx(() => { try { finishEffect(effect, kernelEffect(raw(id), effect)); } catch (e) { finishEffect(effect, { error: e.message }, 'failed'); } });
            if (['waiting_input', 'waiting_children'].includes(raw(id).status)) {
              tx(() => { for (const later of pending(id)) finishEffect(later, { status: 'cancelled', notice: 'This call followed a yield. Reconsider it after the requested answer or child result arrives.' }, 'cancelled'); });
              break;
            }
          } else {
            tx(() => { db.prepare("UPDATE task_effects SET status='executing',updated=? WHERE id=?").run(stamp(), effect.id); event(id, 'tool_started', { effectId: effect.id, tool: effect.tool }); });
            try {
              const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(stepTimeoutMs)]);
              const result = await abortable(binding.execute(effect.tool, JSON.parse(effect.args), { signal, effectId: effect.id }), signal);
              if (closed || controller.signal.aborted) return;
              tx(() => finishEffect(effect, result, toolResultOutcome(result) === 'error' ? 'failed' : 'completed'));
            } catch (e) {
              if (closed || controller.signal.aborted) return;
              if (effect.replay === 'manual') {
                tx(() => { db.prepare("UPDATE task_effects SET status='unknown',updated=? WHERE id=?").run(stamp(), effect.id); setStatus(id, hasCorrection(id) ? 'queued' : 'blocked', 'The write did not return a confirmed result. Check the destination before continuing.'); }); return;
              }
              tx(() => finishEffect(effect, { error: String(e.message || 'Plugin failed').slice(0, 1000) }, 'failed'));
            }
          }
        }
        row = raw(id);
        if (['waiting_input', 'waiting_children'].includes(row.status)) {
          // A user input arriving while a yield tool ran takes precedence over
          // that yield. Child completions alone do not turn waiting into polling.
          if (hasCorrection(id)) tx(() => setStatus(id, 'queued'));
          return;
        }
        if (controller.signal.aborted || closed) return;
        if (row.step_count >= row.step_limit || row.tool_count > row.tool_limit) { tx(() => finish(id, 'failed', row.output, 'Task execution budget reached. Review the result before retrying.')); return; }
        const messages = tx(() => consumeInputs(id));
        if (JSON.stringify(messages).length > 240000) { tx(() => finish(id, 'failed', row.output, 'Task context budget reached. Start a focused follow-up task using the saved results.')); return; }
        const definitions = row.tool_count >= row.tool_limit ? [] : [...(row.role === 'router' ? controlTools : binding.definitions()), questionTool];
        timer = setTimeout(() => controller.abort(new Error('Model step timed out.')), stepTimeoutMs); timer.unref();
        let preview = '', streamed = 0, lastFlush = Date.now();
        const answer = await abortable(model.step({ model: row.model, messages, tools: definitions, signal: controller.signal,
          onDelta(text) {
            if (!closed && !controller.signal.aborted && typeof text === 'string') {
              preview = (preview + text).slice(0, 64000 - streamed);
              if (preview && Date.now() - lastFlush >= 400) { event(id, 'delta', { text: preview }); streamed += preview.length; preview = ''; lastFlush = Date.now(); }
            }
          } }), controller.signal);
        clearTimeout(timer); timer = undefined;
        if (closed || controller.signal.aborted) return;
        const calls = answer.toolCalls ?? [];
        if (!Array.isArray(calls) || calls.length > 8 || new Set(calls.map(c => c.id)).size !== calls.length || calls.some(c => !identity(c.id) || !identity(c.name) || !c.arguments || typeof c.arguments !== 'object' || Array.isArray(c.arguments))) throw Error('Invalid model tool calls.');
        if (row.tool_count + calls.length > row.tool_limit) throw Error('Task tool budget reached.');
        const text = String(answer.text ?? '').slice(0, 64000);
        tx(() => {
          const current = raw(id), history = JSON.parse(current.messages), step = current.step_count + 1;
          const assistant = { role: 'assistant', content: text || null,
            ...(typeof answer.assistantMessage?.reasoning_content === 'string' ? { reasoning_content: answer.assistantMessage.reasoning_content } : {}),
            ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) };
          history.push(assistant);
          db.prepare('UPDATE tasks SET messages=?,step_count=?,tool_count=tool_count+?,updated=? WHERE id=?').run(JSON.stringify(history), step, calls.length, stamp(), id);
          if (text) event(id, calls.length ? 'progress' : 'answer', { text });
          for (const call of calls) {
            const kernel = [...(row.role === 'router' ? controlTools : []), questionTool].some(d => d.function.name === call.name);
            const meta = kernel ? { pluginId: 'kernel', effect: 'read-only', replay: 'safe', approvalRequired: false } : binding.metadata(call.name);
            const def = definitions.find(d => d.function.name === call.name);
            const effectId = id + ':' + step + ':' + call.id;
            // Unavailable calls are durable failed results, so the model can fix
            // the request without executing tools absent from its capability set.
            db.prepare(`INSERT INTO task_effects (id,task_id,call_id,step,tool,args,plugin_id,effect,replay,approval_required,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(effectId, id, call.id, step, call.name, JSON.stringify(call.arguments), meta?.pluginId ?? 'unavailable', meta?.effect ?? 'read-only', meta?.replay ?? 'safe', meta && (meta.approvalRequired ?? meta.effect === 'write') ? 1 : 0, 'pending', stamp(), stamp());
            const effect = db.prepare('SELECT * FROM task_effects WHERE id=?').get(effectId);
            try { if (!meta || !def) throw Error('Tool is not available to this task.'); validateToolArguments(def.function.parameters, call.arguments); }
            catch (e) { finishEffect(effect, { error: e.message }, 'failed'); }
          }
          if (calls.length) setStatus(id, 'queued');
          else if (db.prepare('SELECT 1 FROM task_inputs WHERE task_id=? AND consumed=0').get(id)) setStatus(id, 'queued');
          else if (children(id).some(c => !terminal.has(c.status))) { db.prepare('UPDATE tasks SET output=? WHERE id=?').run(text, id); setStatus(id, 'waiting_children'); }
          else finish(id, 'succeeded', text);
          if (answer.usage) event(id, 'usage', { usage: answer.usage });
        });
      } catch (e) {
        if (!closed && raw(id).status !== 'cancelled') tx(() => finish(id, 'failed', raw(id).output, String(e.message || 'Task execution failed.').slice(0, 1000)));
      } finally {
        clearTimeout(timer);
        try { if (binding?.close) await abortable(binding.close(), AbortSignal.timeout(2000)); } catch { /* cleanup cannot hold a scheduler slot forever */ }
        if (!closed) {
          const row = raw(id);
          if (row.status === 'running') tx(() => finish(id, 'failed', row.output, controller.signal.aborted ? 'Task step was interrupted.' : 'Task stopped without a result.'));
        }
        db.prepare('UPDATE task_attempts SET status=?,finished=? WHERE id=?').run(closed ? 'interrupted' : raw(id).status, stamp(), attemptId);
        controls.delete(id); if (!closed) queueMicrotask(pump);
      }
    };
    control.promise = run();
    await control.promise;
  }
  function pump() {
    if (closed || pumping || !model.configured) return;
    pumping = true;
    try {
      for (const [role, limit] of [['router', 1], ['worker', concurrency]]) {
        let count = [...controls.keys()].filter(id => raw(id).role === role).length;
        while (count < limit) {
          const row = db.prepare("SELECT * FROM tasks WHERE status='queued' AND role=? ORDER BY updated,rowid LIMIT 1").get(role);
          if (!row || controls.has(row.id)) break;
          void execute(row.id); count++;
        }
      }
    } finally { pumping = false; }
  }
  // Restore only after the exclusive runtime lock has been acquired.
  try { tx(() => {
    for (const row of db.prepare("SELECT * FROM tasks WHERE status NOT IN ('succeeded','failed','cancelled')").all()) {
      let unknown = false;
      for (const effect of effects(row.id).filter(e => e.status === 'executing')) {
        const next = effect.replay === 'safe' ? 'pending' : 'unknown';
        db.prepare('UPDATE task_effects SET status=?,updated=? WHERE id=?').run(next, stamp(), effect.id);
        unknown ||= next === 'unknown';
      }
      if (unknown || pending(row.id).some(e => e.status === 'unknown')) setStatus(row.id, 'blocked', 'A write was interrupted before its result was recorded. Verify the actual outcome; it will not be replayed.');
      else if (row.status === 'running') { setStatus(row.id, 'queued'); addInput(row.id, BUILTIN_PROMPTS.recovery.content, 'recovery', randomUUID()); }
    }
    db.prepare("UPDATE task_attempts SET status='interrupted',finished=? WHERE status='running'").run(stamp());
  }); } catch (error) { try { db.close(); } finally { releaseLock(); } throw error; }
  queueMicrotask(pump);

  return {
    create(request) {
      if (closed) fail(503, 'Task runtime is closing.');
      if (!model.configured) fail(503, 'Configure the model provider before starting a task.');
      const { workspaceId, text, requestId, agentId } = request ?? {};
      workspace(workspaceId);
      if (typeof text !== 'string' || !text.trim() || text.length > 16000 || !identity(requestId)) fail(422, 'Use a nonempty task of at most 16000 characters and a stable request ID.');
      const pluginIds = validatePlugins(request.pluginIds ?? plugins.list().filter(p => p.available && p.defaultEnabled).map(p => p.id));
      const modelName = request.model ?? model.models[0];
      if (!model.models.includes(modelName)) fail(422, 'Unsupported task model.');
      selectedAgent(workspaceId, agentId);
      const fingerprint = hash(JSON.stringify([text, pluginIds, modelName, agentId ?? null]));
      const existing = db.prepare('SELECT * FROM tasks WHERE workspace_id=? AND request_key=?').get(workspaceId, 'user:' + requestId);
      if (existing) { if (existing.request_hash !== fingerprint) fail(409, 'Request ID already belongs to a different task.'); return info(existing); }
      if (db.prepare("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('succeeded','failed','cancelled')").get().n >= 100) fail(429, 'Too many unfinished tasks.');
      const row = tx(() => insertTask({ workspaceId, text, pluginIds, model: modelName, agentId, requestKey: 'user:' + requestId, requestHash: fingerprint }));
      queueMicrotask(pump); return info(row);
    },
    list(request) { workspace(request?.workspaceId); return db.prepare('SELECT * FROM tasks WHERE workspace_id=? ORDER BY created DESC,rowid DESC LIMIT 200').all(request.workspaceId).map(info); },
    get(id, request) {
      const row = scope(id, request);
      return { task: info(row), children: children(id).map(info), inputs: db.prepare('SELECT * FROM task_inputs WHERE task_id=? ORDER BY id DESC LIMIT 100').all(id).reverse().map(i => ({ id: String(i.id), text: i.text, source: i.source, createdAt: i.created, consumed: !!i.consumed })),
        events: db.prepare('SELECT event FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT 200').all(id).reverse().map(e => JSON.parse(e.event)) };
    },
    input(id, request) {
      const row = scope(id, request);
      if (row.status === 'cancelled') fail(409, 'This task was cancelled. Create a new task to start again.');
      if (!identity(request.requestId) || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 16000) fail(422, 'Invalid task input.');
      const input = tx(() => resumeInput(id, request.text, 'user', request.requestId));
      queueMicrotask(pump); return { task: info(raw(id)), input: { id: String(input.id), text: input.text, source: input.source, createdAt: input.created, consumed: !!input.consumed } };
    },
    cancel(id, request) {
      const before = scope(id, request);
      const ids = db.prepare('WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree p ON t.parent_id=p.id) SELECT id FROM tree').all(id).map(r => r.id);
      tx(() => { for (const child of ids) { const row = raw(child); if (!terminal.has(row.status)) { setStatus(child, 'cancelled'); event(child, 'cancelled'); } } });
      for (const child of ids) controls.get(child)?.controller.abort(new Error('Task cancelled.'));
      // Cancelling a single child is also a terminal event its parent can consume.
      tx(() => { const row = raw(id); if (row.parent_id && !terminal.has(before.status)) { db.prepare('UPDATE tasks SET completion=completion+1 WHERE id=?').run(id); notifyParent(raw(id)); } });
      queueMicrotask(pump); return info(raw(id));
    },
    retry(id, request) {
      const row = scope(id, request);
      if (!['failed', 'blocked'].includes(row.status)) fail(409, 'Only failed or blocked tasks can be retried.');
      if (pending(id).some(e => e.status === 'unknown')) fail(409, 'A write has an unknown outcome. Inspect the destination and send a follow-up with the result; retry will not replay it.');
      tx(() => { db.prepare('UPDATE tasks SET step_limit=step_count+?,tool_limit=tool_count+? WHERE id=?').run(maxSteps, maxTools, id); addInput(id, BUILTIN_PROMPTS.recovery.content, 'recovery', randomUUID()); setStatus(id, 'queued'); });
      queueMicrotask(pump); return info(raw(id));
    },
    decide(id, effectId, request) {
      const row = scope(id, request);
      if (!['approve', 'deny'].includes(request.decision)) fail(422, 'Invalid approval decision.');
      const effect = db.prepare('SELECT * FROM task_effects WHERE id=? AND task_id=?').get(effectId, id);
      if (!effect) fail(404, 'Task action not found.');
      if (effect.status !== 'awaiting_approval') return info(row);
      if (row.status === 'cancelled') fail(409, 'Task was cancelled.');
      tx(() => {
        if (request.decision === 'deny') finishEffect(effect, { status: 'denied', notice: 'The user declined this exact action. Do not try an alternative route to perform it.' }, 'denied');
        else db.prepare("UPDATE task_effects SET approved=1,status='pending',updated=? WHERE id=?").run(stamp(), effectId);
        setStatus(id, 'queued');
      });
      queueMicrotask(pump); return info(raw(id));
    },
    config(request) {
      workspace(request?.workspaceId);
      return { configured: !!model.configured, models: [...model.models], plugins: plugins.list(), prompts: ['router', 'worker'].map(role => prompt(request.workspaceId, role)), limits: { concurrency, maxSteps, maxChildren, maxTools } };
    },
    savePrompt(role, request) {
      workspace(request?.workspaceId); const current = prompt(request.workspaceId, role);
      if (!Number.isInteger(request.revision) || current.revision !== request.revision) fail(409, 'Prompt changed. Reload its current version before saving.');
      if (request.content !== null && (typeof request.content !== 'string' || !request.content.trim() || request.content.length > 16000)) fail(422, 'Prompt must contain 1–16000 characters, or null to restore the default.');
      const content = request.content ?? BUILTIN_PROMPTS[role].content;
      db.prepare('INSERT INTO task_prompts VALUES (?,?,?,?,?,?)').run(request.workspaceId, role, current.revision + 1, request.content, hash(content), stamp());
      return prompt(request.workspaceId, role);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const control of controls.values()) control.controller.abort(new Error('Host stopping.'));
      await Promise.allSettled([...controls.values()].map(c => c.promise));
      // Persisted running rows and effects deliberately remain recoverable.
      db.close();
      releaseLock();
    },
  };
}
