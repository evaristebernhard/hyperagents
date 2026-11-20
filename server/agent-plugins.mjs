import { randomUUID } from 'node:crypto';
import { createWorkspaceTools } from './tools.mjs';
import { createExaTools } from './exa-tools.mjs';
import { createFreeSearchTools } from './free-search.mjs';
import { createPublicTools } from './public-tools.mjs';
import { createToolRegistry, validateToolArguments } from './tool-registry.mjs';

const LOCAL_CAPABILITIES = ['Thread Search', 'Documents', 'Webpages', 'Tables', 'Slides'];
const READ_CAPABILITIES = { search_threads: 'Thread Search', get_thread_messages: 'Thread Search', search_documents: 'Documents', read_document: 'Documents', search_tables: 'Tables', get_table: 'Tables' };
const BROAD_READS = new Set(['workspace_search', 'resource_read', 'resource_read_page']);
const RESERVED = new Set(['delegate_task', 'send_task_input', 'list_task_children', 'wait_for_tasks', 'request_user_input', 'read_task_result', 'tool_catalog']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const effectIdentity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new Error(message); };

// bind is synchronous, so failed construction starts cleanup without awaiting it.
// Every prior runtime gets a close attempt even if one throws or rejects.
function discardRuntime(runtime) {
  try {
    if (runtime && typeof runtime.then === 'function') {
      // Async bind is invalid, but still dispose a runtime it eventually creates.
      void Promise.resolve(runtime).then(value => value?.close?.()).catch(() => {});
    } else void Promise.resolve(runtime?.close?.()).catch(() => {});
  } catch { /* Preserve the original binding failure. */ }
}

function scope(load, workspaceId, agentId) {
  const loaded = load(), state = loaded?.state ?? loaded;
  const found = state?.workspaces?.filter(workspace => workspace.id === workspaceId && !workspace.archived);
  if (found?.length !== 1) fail('Workspace not found.');
  const workspace = found[0];
  let agent;
  if (agentId !== undefined) {
    const agents = workspace.data?.agents?.filter(item => item.id === agentId && !item.archived);
    if (agents?.length !== 1) fail('Agent not found in this workspace.');
    agent = agents[0];
  }
  return { workspace, agent, capabilities: agent ? [...new Set(Array.isArray(agent.tools) ? agent.tools.filter(item => typeof item === 'string') : [])] : null };
}

function allowed(tool, pluginId, current) {
  if (current.capabilities === null) return true;
  // The legacy broad resource readers intentionally have no narrower capability boundary.
  if (tool.unrestrictedWorkspace) return false;
  const required = tool.capability ?? pluginId;
  return (Array.isArray(required) ? required : [required]).some(capability => current.capabilities.includes(capability));
}

function jsonArguments(value, depth = 0) {
  if (depth > 12) fail('Tool arguments are too deeply nested.');
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const item of value) jsonArguments(item, depth + 1); return; }
  if (!plain(value)) fail('Tool arguments must contain JSON values.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Invalid tool argument property.');
    jsonArguments(descriptor.value, depth + 1);
  }
}

function readRuntime(workspace, taskId, enabled, readAttachment) {
  // createWorkspaceTools predates tasks and needs a thread context even for reads.
  // This excluded context exists only in an isolated adapter snapshot. It is never
  // persisted, searchable, returned as a task's conversation, or used for writes.
  const threadId = `agent-read-${randomUUID()}`;
  const state = { workspaces: [{ ...workspace, data: { ...workspace.data, threads: [...(workspace.data.threads || []), { id: threadId, title: '', excluded: true, messages: [] }] } }] };
  return createWorkspaceTools({ state, workspaceId: workspace.id, threadId, enabled, readAttachment, maxCalls: 1 });
}

const documentDefinition = { type: 'function', function: {
  name: 'task_save_document',
  description: 'Save the complete Markdown deliverable as a real Document artifact in this task workspace. Returns the saved artifact ID. The task effect ID makes retries idempotent; do not invent file URLs.',
  parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 512 }, content: { type: 'string', minLength: 1, maxLength: 100000 } }, required: ['title', 'content'], additionalProperties: false },
} };

/** Server-authored plugin protocol (no request-supplied modules or executable paths):
 * { id, name, description, available=true, defaultEnabled=false,
 *   tools: [{ definition, effect:'read-only'|'write', replay?:'safe'|'manual',
 *             approvalRequired?:boolean, capability?:string|string[] }],
 *   bind({workspaceId,taskId,role,agentId?,capabilities:null|string[]}) =>
 *     { execute(name,args,{signal,effectId}), close?() } }
 * bind is synchronous; execute/close may be async. capability is an existing
 * agent.tools label; absent capability defaults to the plugin id. Write tools
 * default to manual replay + approval. The task runtime enforces that gate.
 */
export function createAgentPlugins({ load, readAttachment, publicFetch = globalThis.fetch, exaApiKey, exaFetch = globalThis.fetch, openAlexApiKey, publicUserAgent, persistArtifact, freeSearchDisabled = false, plugins = [] } = {}) {
  if (typeof load !== 'function' || !Array.isArray(plugins)) fail('Invalid agent plugin configuration.');
  const exa = createExaTools({ enabled: ['Search', 'Find Similar'], apiKey: exaApiKey, fetchImpl: exaFetch });
  const free = createFreeSearchTools({ enabled: exa.capabilities.some(item => item.service === 'Search' && item.configured) ? [] : ['Search'], disabled: freeSearchDisabled, fetchImpl: publicFetch });
  const scholarly = createPublicTools({ enabled: ['OpenAlex'], fetchImpl: publicFetch, openAlexApiKey, userAgent: publicUserAgent });
  const webAdapters = [exa, free, scholarly];
  const readSchemaRuntime = readRuntime({ id: 'schema', data: { threads: [] } }, 'schema', LOCAL_CAPABILITIES);
  const builtins = [
    {
      id: 'workspace-read', name: 'Workspace', description: 'Read and search saved workspace documents, tables, conversations, and resources.', available: true, defaultEnabled: true,
      tools: readSchemaRuntime.definitions.filter(definition => READ_CAPABILITIES[definition.function.name] || BROAD_READS.has(definition.function.name)).map(definition => ({ definition, effect: 'read-only', replay: 'safe', capability: READ_CAPABILITIES[definition.function.name], unrestrictedWorkspace: BROAD_READS.has(definition.function.name) })),
      bind(context) { return { async execute(name, args, { signal } = {}) {
        signal?.throwIfAborted();
        const current = scope(load, context.workspaceId, context.agentId);
        const enabled = current.capabilities === null ? LOCAL_CAPABILITIES : LOCAL_CAPABILITIES.filter(capability => current.capabilities.includes(capability));
        return readRuntime(current.workspace, context.taskId, enabled, readAttachment).execute(name, args);
      } }; },
    },
    {
      id: 'web-search', name: 'Web search', description: 'Search public web sources with configured Exa or keyless Bing RSS, and scholarly works when OpenAlex is configured.', available: webAdapters.some(adapter => adapter.definitions.length), defaultEnabled: true,
      tools: webAdapters.flatMap(adapter => adapter.definitions.map(definition => ({ definition, effect: 'read-only', replay: 'safe', capability: definition.function.name === 'openalex_search' ? 'OpenAlex' : definition.function.name === 'exa_find_similar' ? 'Find Similar' : 'Search' }))),
      bind() { return { execute(name, args, { signal } = {}) {
        const adapter = webAdapters.find(item => item.definitions.some(definition => definition.function.name === name));
        if (!adapter) fail('Search tool unavailable.');
        return adapter.execute(name, args, signal);
      } }; },
    },
    {
      id: 'documents', name: 'Documents', description: 'Save Markdown deliverables as workspace Document artifacts attached to the durable task.', available: typeof persistArtifact === 'function', defaultEnabled: true,
      tools: [{ definition: documentDefinition, effect: 'write', replay: 'safe', approvalRequired: false, capability: 'Documents' }],
      bind(context) { return { async execute(_name, args, { signal, effectId } = {}) {
        if (!effectIdentity(effectId)) fail('Saving a document requires a stable effect ID.');
        if (!args.title.trim() || !args.content.trim()) fail('Document title and content must not be blank.');
        signal?.throwIfAborted();
        // Persistence must derive identity from workspace/task/effect, atomically
        // return an existing matching artifact on retry, and reject mismatches.
        const saved = await persistArtifact({ workspaceId: context.workspaceId, taskId: context.taskId, effectId, title: args.title.trim(), content: args.content, kind: 'Document', signal });
        if (!plain(saved) || !id(saved.id) || (saved.workspaceId !== undefined && saved.workspaceId !== context.workspaceId)) fail('Document storage did not return a valid artifact reference.');
        return { status: 'saved', id: saved.id, title: args.title.trim(), kind: 'Document', workspaceId: context.workspaceId, taskId: context.taskId };
      } }; },
    },
  ];

  const registered = new Map(), toolNames = new Set();
  for (const plugin of [...builtins, ...plugins]) {
    if (!plain(plugin) || !/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id) || typeof plugin.name !== 'string' || !plugin.name.trim() || plugin.name.length > 200 || typeof plugin.description !== 'string' || plugin.description.length > 2000 || !Array.isArray(plugin.tools) || plugin.tools.length > 128 || typeof plugin.bind !== 'function' || (plugin.available !== undefined && typeof plugin.available !== 'boolean') || (plugin.defaultEnabled !== undefined && typeof plugin.defaultEnabled !== 'boolean')) fail('Invalid server plugin registration.');
    if (registered.has(plugin.id)) fail(`Duplicate plugin registration: ${plugin.id}`);
    const tools = plugin.tools.map(tool => {
      if (!plain(tool) || !['read-only', 'write'].includes(tool.effect) || (tool.replay !== undefined && !['safe', 'manual'].includes(tool.replay)) || (tool.approvalRequired !== undefined && typeof tool.approvalRequired !== 'boolean')) fail('Invalid plugin tool metadata.');
      const capability = tool.capability;
      if (capability !== undefined && !(typeof capability === 'string' && capability.length > 0 && capability.length <= 200) && !(Array.isArray(capability) && capability.length > 0 && capability.length <= 20 && capability.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200))) fail('Invalid plugin capability.');
      const definition = createToolRegistry([{ source: 'managed', effect: tool.effect === 'write' ? 'approval-gated' : 'read-only', definitions: [tool.definition], execute() {} }], { catalog: false }).definitions()[0];
      const name = definition.function.name;
      if (RESERVED.has(name) || toolNames.has(name)) fail(`Duplicate or reserved tool registration: ${name}`);
      toolNames.add(name);
      return { ...tool, definition, replay: tool.replay ?? (tool.effect === 'write' ? 'manual' : 'safe'), approvalRequired: tool.approvalRequired ?? tool.effect === 'write' };
    });
    registered.set(plugin.id, { ...plugin, tools, available: plugin.available !== false, defaultEnabled: plugin.defaultEnabled === true });
  }

  return {
    list() {
      return [...registered.values()].map(plugin => ({ id: plugin.id, name: plugin.name, description: plugin.description, available: plugin.available, defaultEnabled: plugin.defaultEnabled, tools: plugin.tools.map(tool => tool.definition.function.name) }));
    },
    bind({ workspaceId, taskId, role, pluginIds, agentId } = {}) {
      if (!id(workspaceId) || !id(taskId) || !['router', 'worker'].includes(role) || (agentId !== undefined && !id(agentId))) fail('Invalid plugin binding scope.');
      const current = scope(load, workspaceId, agentId);
      if (pluginIds !== undefined && (!Array.isArray(pluginIds) || pluginIds.length > 100 || pluginIds.some(value => typeof value !== 'string') || new Set(pluginIds).size !== pluginIds.length)) fail('Invalid plugin selection.');
      const selected = pluginIds ?? [...registered.values()].filter(plugin => plugin.available && plugin.defaultEnabled).map(plugin => plugin.id);
      for (const selectedId of selected) if (!registered.has(selectedId) || !registered.get(selectedId).available) fail('Selected plugin is unavailable.');
      const entries = new Map(), runtimes = [];
      let closed = false;
      try {
        // Router capabilities are supplied by the task kernel, never by external plugins.
        if (role === 'worker') for (const selectedId of selected) {
          const plugin = registered.get(selectedId), permitted = plugin.tools.filter(tool => allowed(tool, plugin.id, current));
          if (!permitted.length) continue;
          const context = { workspaceId, taskId, role, ...(agentId ? { agentId } : {}), capabilities: current.capabilities === null ? null : [...current.capabilities] };
          const runtime = plugin.bind(Object.freeze(context));
          runtimes.push(runtime);
          if (!runtime || typeof runtime.execute !== 'function' || typeof runtime.then === 'function' || (runtime.close !== undefined && typeof runtime.close !== 'function')) fail('Invalid plugin runtime.');
          for (const tool of permitted) entries.set(tool.definition.function.name, { pluginId: plugin.id, tool, runtime });
        }
      } catch (error) {
        for (const runtime of runtimes) discardRuntime(runtime);
        throw error;
      }
      return {
        definitions: () => [...entries.values()].map(entry => structuredClone(entry.tool.definition)),
        metadata(name) {
          const entry = entries.get(name);
          return entry ? { pluginId: entry.pluginId, effect: entry.tool.effect, replay: entry.tool.replay, approvalRequired: entry.tool.approvalRequired } : undefined;
        },
        async execute(name, args, { signal, effectId } = {}) {
          if (closed) fail('Plugin binding is closed.');
          if (signal !== undefined && !(signal instanceof AbortSignal)) fail('Invalid cancellation signal.');
          signal?.throwIfAborted();
          const entry = entries.get(name);
          if (!entry) fail('This tool is not enabled for the task.');
          // Re-check an agent's current permissions; a stale binding cannot retain
          // capabilities removed from the saved agent during a long-running task.
          if (!allowed(entry.tool, entry.pluginId, scope(load, workspaceId, agentId))) fail('This tool is no longer authorized for the agent.');
          if (!plain(args)) fail('Tool arguments must be a JSON object.');
          jsonArguments(args);
          validateToolArguments(entry.tool.definition.function.parameters, args);
          const result = await entry.runtime.execute(name, structuredClone(args), { signal, effectId });
          signal?.throwIfAborted();
          return result;
        },
        async close() {
          if (closed) return;
          closed = true;
          const results = await Promise.allSettled(runtimes.map(async runtime => runtime.close?.()));
          const failed = results.find(result => result.status === 'rejected');
          if (failed) throw failed.reason;
        },
      };
    },
  };
}
