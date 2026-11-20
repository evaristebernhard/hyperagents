import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserNamespace, createPersistentBrowserTools } from './persistent-browser-tools.mjs';
import { createApp } from './app.mjs';
import { emptyState } from './validation.mjs';
import { validateToolArguments } from './tool-registry.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) { for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(5); } throw Error('Persistent-browser fixture did not settle'); }
function fixtureClient(initial = {}) {
  const calls = []; let control = initial.control || 'agent', epoch = initial.epoch ?? 1, complete;
  const client = { configured: true, calls,
    capabilities: async () => ({ configured: true, persistent: true }),
    async handle(req, res, scope) { calls.push({ operation: 'proxy', owner: scope.owner, path: req.url, data: scope.data }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return true; },
    async open(owner) { calls.push({ operation: 'open', owner }); return { session: { id: 'fixture-session', control, epoch } }; },
    async agent(owner, id, operation, data) { calls.push({ operation, owner, id, data }); if (control !== 'agent' && operation !== 'status') throw Object.assign(Error('Human controls the browser'), { status: 423 }); return operation === 'screenshot' ? new Response(Buffer.from([137,80,78,71,13,10,26,10]), { headers: { 'Content-Type': 'image/png' } }) : { session: { id, control, epoch }, observation: { title: 'Controlled fixture page', text: 'Actual fixture observation' } }; },
    async requestTakeover(owner, id) { control = 'paused'; epoch++; calls.push({ operation: 'requestTakeover', owner, id }); return { session: { id, control, epoch } }; },
    async waitForHandback(owner, id, options) { calls.push({ operation: 'waitForHandback', owner, id, afterEpoch: options.afterEpoch, timeoutMs:options.timeoutMs }); return new Promise((resolve, reject) => { complete = () => { control = 'agent'; epoch++; resolve({ session: { id, control, epoch }, observation: { title: 'Fixture JD page after explicit handback', text: 'No account data' } }); }; options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }); },
    async release(owner, id) { calls.push({ operation: 'release', owner, id }); },
    handback() { complete(); },
  }; return client;
}

test('workspace namespaces are stable hashes, including arbitrary legal Unicode identifiers', () => {
  assert.match(browserNamespace('workspace.中文/identifier'), /^hyperagents:[a-f0-9]{64}$/);
  assert.equal(browserNamespace('workspace.中文/identifier'), browserNamespace('workspace.中文/identifier'));
  assert.notEqual(browserNamespace('one'), browserNamespace('two'));
});

test('persistent tools bind real returned session IDs, reject foreign sessions and private URLs', async () => {
  const client = fixtureClient(), tools = createPersistentBrowserTools({ client, workspaceId: 'personal', enabled: ['Browser'] });
  assert.equal(tools.persistent, true);
  await assert.rejects(tools.execute('browser_observe', { sessionId: 'unbound' }), /not bound/);
  await tools.execute('browser_session', { action: 'create', url: 'https://www.jd.com/' });
  assert.equal(client.calls[0].owner, browserNamespace('personal'));
  await tools.execute('browser_navigate', { sessionId: 'fixture-session', url: 'https://www.jd.com/' });
  assert.equal(client.calls.at(-1).operation, 'navigate');
  await assert.rejects(tools.execute('browser_navigate', { sessionId: 'fixture-session', url: 'file:///etc/passwd' }), /public HTTPS/);
  await assert.rejects(tools.execute('browser_navigate', { sessionId: 'fixture-session', url: 'https://127.0.0.1/' }), /public HTTPS/);
  await tools.close(); assert.equal(client.calls.at(-1).operation, 'release');
  assert.equal(client.calls.some(call => call.operation === 'close'), false);
});

test('model schemas expose create before binding and only actual bound session IDs after create or release',async()=>{
  const client=fixtureClient();let created=0;
  client.open=async()=>{created++;return{session:{id:'real-session-'+created,profileId:'real-profile-'+created,control:'agent',epoch:1}};};
  const tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser']});
  const initial=tools.modelDefinitions();assert.deepEqual(initial.map(item=>item.function.name),['browser_session']);
  assert.deepEqual(initial[0].function.parameters.properties.action.enum,['create']);
  assert.equal(initial[0].function.parameters.properties.sessionId,undefined);
  assert.equal(initial[0].function.parameters.properties.profileId,undefined);
  initial[0].function.parameters.properties.action.enum.push('close');
  assert.deepEqual(tools.modelDefinitions()[0].function.parameters.properties.action.enum,['create']);
  assert.ok(tools.definitions.some(item=>item.function.name==='browser_request_takeover'));
  await assert.rejects(tools.execute('browser_request_takeover',{sessionId:'invented'}),/not bound/);
  assert.equal(client.calls.length,0);
  await tools.execute('browser_session',{action:'create'});
  const bound=tools.modelDefinitions();assert.ok(bound.some(item=>item.function.name==='browser_request_takeover'));assert.ok(bound.some(item=>item.function.name==='browser_observe'));
  assert.deepEqual(bound.find(item=>item.function.name==='browser_session').function.parameters.properties.profileId.enum,['real-profile-1']);
  assert.ok(!bound.some(item=>item.function.name==='browser_wait_for_handback'));
  for(const item of bound)assert.deepEqual(item.function.parameters.properties.sessionId.enum,['real-session-1']);
  await tools.execute('browser_session',{action:'create'});
  assert.deepEqual(tools.modelDefinitions().find(item=>item.function.name==='browser_observe').function.parameters.properties.sessionId.enum,['real-session-1','real-session-2']);
  assert.deepEqual(tools.modelDefinitions().find(item=>item.function.name==='browser_session').function.parameters.properties.profileId.enum,['real-profile-1','real-profile-2']);
  await tools.execute('browser_session',{action:'close',sessionId:'real-session-1'});
  assert.deepEqual(tools.modelDefinitions().find(item=>item.function.name==='browser_observe').function.parameters.properties.sessionId.enum,['real-session-2']);
  assert.deepEqual(tools.modelDefinitions().find(item=>item.function.name==='browser_session').function.parameters.properties.profileId.enum,['real-profile-2']);
  await assert.rejects(tools.execute('browser_observe',{sessionId:'real-session-1'}),/not bound/);
  await tools.execute('browser_session',{action:'close',sessionId:'real-session-2'});
  assert.deepEqual(tools.modelDefinitions().map(item=>item.function.name),['browser_session']);
  assert.equal(tools.modelDefinitions()[0].function.parameters.properties.profileId,undefined);
  await tools.close();assert.deepEqual(tools.modelDefinitions(),[]);
  assert.deepEqual(createPersistentBrowserTools({client,workspaceId:'personal',enabled:[]}).modelDefinitions(),[]);
});

test('model schemas never guess profiles when open omits a real profile and deduplicate known bound profiles',async()=>{
  const client=fixtureClient(),tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser']});
  await tools.execute('browser_session',{action:'create'});
  assert.equal(tools.modelDefinitions().find(item=>item.function.name==='browser_session').function.parameters.properties.profileId,undefined);
  let created=0;client.open=async()=>({session:{id:'actual-profile-session-'+(++created),profileId:'same-real-profile',control:'agent',epoch:1}});
  await tools.execute('browser_session',{action:'create'});await tools.execute('browser_session',{action:'create'});
  const definition=tools.modelDefinitions().find(item=>item.function.name==='browser_session');
  assert.deepEqual(definition.function.parameters.properties.profileId.enum,['same-real-profile']);
  definition.function.parameters.properties.profileId.enum.push('invented-profile');
  assert.deepEqual(tools.modelDefinitions().find(item=>item.function.name==='browser_session').function.parameters.properties.profileId.enum,['same-real-profile']);
  await tools.execute('browser_session',{action:'close',sessionId:'actual-profile-session-1'});
  assert.deepEqual(tools.modelDefinitions().find(item=>item.function.name==='browser_session').function.parameters.properties.profileId.enum,['same-real-profile']);
  await tools.execute('browser_session',{action:'close',sessionId:'actual-profile-session-2'});
  assert.equal(tools.modelDefinitions().find(item=>item.function.name==='browser_session').function.parameters.properties.profileId,undefined);
  assert.ok(tools.definitions.find(item=>item.function.name==='browser_session').function.parameters.properties.profileId);
  await tools.close();
});

test('takeover blocks agent actions and waiting resolves only after explicit epoch-advancing handback', async () => {
  const events=[];
  const client = fixtureClient(), tools = createPersistentBrowserTools({ client, workspaceId: 'personal', enabled: ['Browser'], onHumanWait:event=>events.push(event) });
  await tools.execute('browser_session', { action: 'create' });
  let finished = false;
  const waiting = tools.execute('browser_request_takeover', { sessionId: 'fixture-session' }).then(value => { finished = true; return value; });
  await eventually(()=>client.calls.some(call=>call.operation==='waitForHandback'));
  assert.deepEqual(tools.modelDefinitions().find(item=>item.function.name==='browser_wait_for_handback').function.parameters.properties.sessionId.enum,['fixture-session']);
  assert.deepEqual(events,[{status:'waiting',sessionId:'fixture-session',epoch:2}]);
  await assert.rejects(tools.execute('browser_observe', { sessionId: 'fixture-session' }), error => error.status === 423);
  await sleep(15); assert.equal(finished, false); client.handback();
  const result = await waiting; assert.equal(result.resumedAfterExplicitHandback, true); assert.ok(result.session.epoch > client.calls.find(call=>call.operation==='waitForHandback').afterEpoch); assert.match(result.observation.title, /explicit handback/);
  assert.ok(!tools.modelDefinitions().some(item=>item.function.name==='browser_wait_for_handback'));
  assert.deepEqual(events,[{status:'waiting',sessionId:'fixture-session',epoch:2},{status:'resumed',sessionId:'fixture-session',epoch:3}]);
  await tools.close();
});

test('takeover defaults to thirty minutes and accepts only bounded internal human wait configuration',async()=>{
  for(const timeout of[undefined,1,125000,5*60*60*1000]){
    const client=fixtureClient(),tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser'],...(timeout===undefined?{}:{humanWaitTimeoutMs:timeout})});
    await tools.execute('browser_session',{action:'create'});
    const waiting=tools.execute('browser_request_takeover',{sessionId:'fixture-session'});
    await eventually(()=>client.calls.some(call=>call.operation==='waitForHandback'));
    assert.equal(client.calls.find(call=>call.operation==='waitForHandback').timeoutMs,timeout??1800000);
    client.handback();await waiting;await tools.close();
  }
  for(const timeout of[0,-1,1.1,5*60*60*1000+1,NaN,Infinity,'1800000',null])assert.throws(()=>createPersistentBrowserTools({workspaceId:'personal',humanWaitTimeoutMs:timeout}),/human wait timeout/);
});

test('internal long human wait does not expand the explicit handback tool timeout or accept model-supplied overrides',async()=>{
  const client=fixtureClient(),tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser'],humanWaitTimeoutMs:18000000});
  await tools.execute('browser_session',{action:'create'});
  for(const args of[{sessionId:'fixture-session',humanWaitTimeoutMs:18000000},{sessionId:'fixture-session',timeoutSeconds:18000}])await assert.rejects(tools.execute('browser_request_takeover',args),/Unexpected tool argument/);
  await assert.rejects(tools.execute('browser_wait_for_handback',{sessionId:'fixture-session',timeoutSeconds:601}),/numeric argument/);
  const timeouts=[];client.waitForHandback=async(_owner,id,options)=>{timeouts.push(options.timeoutMs);if(timeouts.length===1)throw Error('Isolated request timeout');return{session:{id,control:'agent',epoch:options.afterEpoch+1},observation:{text:'Confirmed test handback'}};};
  await assert.rejects(tools.execute('browser_request_takeover',{sessionId:'fixture-session'}),error=>error.code==='BROWSER_HANDBACK_REQUIRED');
  await tools.execute('browser_wait_for_handback',{sessionId:'fixture-session',timeoutSeconds:12});
  assert.deepEqual(timeouts,[18000000,12000]);await tools.close();
});

test('connecting an already human-controlled session exposes only host-window handback waiting until actual handback',async()=>{
  const client=fixtureClient({control:'human',epoch:6}),events=[];
  const tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser'],humanWaitTimeoutMs:2700000,onHumanWait:event=>events.push(event)});
  await assert.rejects(tools.execute('browser_session',{action:'create',control:'human',epoch:6}),/Unexpected tool argument/);
  await tools.execute('browser_session',{action:'create'});
  const projected=tools.modelDefinitions();assert.deepEqual(projected.map(item=>item.function.name),['browser_wait_for_handback']);
  assert.deepEqual(projected[0].function.parameters.properties.sessionId.enum,['fixture-session']);assert.equal(projected[0].function.parameters.properties.timeoutSeconds,undefined);
  assert.throws(()=>validateToolArguments(projected[0].function.parameters,{sessionId:'fixture-session',timeoutSeconds:600}),/Unexpected tool argument/);
  await assert.rejects(tools.execute('browser_request_takeover',{sessionId:'fixture-session'}),error=>error.status===423);
  await assert.rejects(tools.execute('browser_observe',{sessionId:'fixture-session'}),error=>error.status===423);
  await assert.rejects(tools.execute('browser_session',{action:'create'}),/waiting for human handback/);
  assert.deepEqual(client.calls.map(call=>call.operation),['open']);
  const waiting=tools.execute('browser_wait_for_handback',{sessionId:'fixture-session'});
  await eventually(()=>client.calls.some(call=>call.operation==='waitForHandback'));
  assert.equal(client.calls.at(-1).afterEpoch,6);assert.equal(client.calls.at(-1).timeoutMs,2700000);
  client.handback();const result=await waiting;assert.equal(result.session.epoch,7);
  assert.deepEqual(events,[{status:'waiting',sessionId:'fixture-session',epoch:6},{status:'resumed',sessionId:'fixture-session',epoch:7}]);
  assert.ok(tools.modelDefinitions().some(item=>item.function.name==='browser_observe'));assert.ok(!tools.modelDefinitions().some(item=>item.function.name==='browser_wait_for_handback'));
  assert.ok(!client.calls.some(call=>call.operation==='requestTakeover'));await tools.close();
});

test('mixed-session projections exclude human IDs from agent actions and release removes the human fence',async()=>{
  const client=fixtureClient(),opened=[
    {id:'agent-session',profileId:'agent-profile',control:'agent',epoch:1},
    {id:'human-session',profileId:'human-profile',control:'human',epoch:6},
  ];client.open=async()=>({session:opened.shift()});
  const tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser']});
  await tools.execute('browser_session',{action:'create'});await tools.execute('browser_session',{action:'create'});
  for(const item of tools.modelDefinitions()){
    const {name,parameters}=item.function;
    if(name==='browser_wait_for_handback')assert.deepEqual(parameters.properties.sessionId.enum,['human-session']);
    else if(name==='browser_session'){assert.deepEqual(parameters.properties.action.enum,['status','close']);assert.deepEqual(parameters.properties.sessionId.enum,['agent-session','human-session']);assert.ok(parameters.required.includes('sessionId'));assert.equal(parameters.properties.profileId,undefined);}
    else assert.deepEqual(parameters.properties.sessionId.enum,['agent-session'],name);
  }
  const observe=tools.modelDefinitions().find(item=>item.function.name==='browser_observe');assert.throws(()=>validateToolArguments(observe.function.parameters,{sessionId:'human-session'}),/Unsupported tool argument/);
  await assert.rejects(tools.execute('browser_request_takeover',{sessionId:'human-session'}),error=>error.status===423);
  await tools.execute('browser_session',{action:'close',sessionId:'human-session'});
  const restored=tools.modelDefinitions();assert.ok(!restored.some(item=>item.function.name==='browser_wait_for_handback'));
  const connection=restored.find(item=>item.function.name==='browser_session');assert.ok(connection.function.parameters.properties.action.enum.includes('create'));assert.deepEqual(connection.function.parameters.properties.profileId.enum,['agent-profile']);
  for(const item of restored)assert.deepEqual(item.function.parameters.properties.sessionId.enum,['agent-session']);await tools.close();
});

test('invalid open epochs cannot create human wait bindings, and an unconfirmed handback retains the human fence',async()=>{
  for(const epoch of[undefined,null,-1,1.5,NaN,Infinity,'6',Number.MAX_SAFE_INTEGER+1]){
    const client=fixtureClient();client.open=async()=>({session:{id:'invalid-human-session',control:'human',epoch}});
    const tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser']});
    await assert.rejects(tools.execute('browser_session',{action:'create'}),/valid human control epoch/);
    assert.deepEqual(tools.modelDefinitions().map(item=>item.function.name),['browser_session']);assert.ok(client.calls.some(call=>call.operation==='release'&&call.id==='invalid-human-session'));await tools.close();
  }
  for(const returned of[
    {session:{id:'fixture-session',control:'agent',epoch:6},observation:{text:'stale epoch'}},
    {session:{id:'fixture-session',control:'human',epoch:7},observation:{text:'still human'}},
  ]){
    const client=fixtureClient({control:'human',epoch:6}),timeouts=[];client.waitForHandback=async(_owner,_id,options)=>{timeouts.push(options.timeoutMs);return returned;};
    const tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser'],humanWaitTimeoutMs:18000000});await tools.execute('browser_session',{action:'create'});
    await assert.rejects(tools.execute('browser_wait_for_handback',{sessionId:'fixture-session',timeoutSeconds:12}),error=>error.code==='BROWSER_HANDBACK_REQUIRED');
    assert.deepEqual(timeouts,[12000]);assert.deepEqual(tools.modelDefinitions().map(item=>item.function.name),['browser_wait_for_handback']);
    await tools.execute('browser_session',{action:'close',sessionId:'fixture-session'});assert.deepEqual(tools.modelDefinitions().map(item=>item.function.name),['browser_session']);await tools.close();
  }
});

test('handoff notifications never claim a resume without the same session and actual handback observation',async()=>{
  for(const returned of [
    {session:{id:'other-session',control:'agent',epoch:3},observation:{text:'wrong session'}},
    {session:{id:'fixture-session',control:'human',epoch:3},observation:{text:'still human'}},
    {session:{id:'fixture-session',control:'agent',epoch:2},observation:{text:'stale epoch'}},
    {session:{id:'fixture-session',control:'agent',epoch:3}},
  ]){
    const client=fixtureClient(),events=[];
    client.waitForHandback=async()=>returned;
    const tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser'],onHumanWait:event=>events.push(event)});
    await tools.execute('browser_session',{action:'create'});
    await assert.rejects(tools.execute('browser_request_takeover',{sessionId:'fixture-session'}),error=>error.code==='BROWSER_HANDBACK_REQUIRED');
    assert.deepEqual(events,[{status:'waiting',sessionId:'fixture-session',epoch:2}]);
    await tools.close();
  }
});

test('persistent screenshots are saved through real host persistence references, not invented URLs', async () => {
  const client = fixtureClient(); let saved;
  const tools = createPersistentBrowserTools({ client, workspaceId: 'personal', enabled: ['Browser'], persistFile: async file => { saved = file; return { id: 'file-isolated-fixture', mimeType: file.mimeType, size: file.bytes.length }; } });
  await tools.execute('browser_session', { action: 'create' });
  const result = await tools.execute('browser_screenshot', { sessionId: 'fixture-session' });
  assert.equal(result.file.id, 'file-isolated-fixture'); assert.equal(saved.bytes.length, 8); assert.equal(result.url, undefined); await tools.close();
  const disabled = createPersistentBrowserTools({ client, workspaceId: 'personal', enabled: [] }); assert.deepEqual(disabled.definitions, []);
});

test('observed interaction tools pass only bounded ref actions, never selectors or script evaluation', async () => {
  const client=fixtureClient(),tools=createPersistentBrowserTools({client,workspaceId:'personal',enabled:['Browser']});
  await tools.execute('browser_session',{action:'create'});
  const common={sessionId:'fixture-session',observationId:'actual-observation-1'};
  await tools.execute('browser_fill',{...common,ref:'e2',text:'ordinary search'});
  assert.deepEqual(client.calls.at(-1),{operation:'agent-action',owner:browserNamespace('personal'),id:'fixture-session',data:{observationId:'actual-observation-1',ref:'e2',text:'ordinary search',action:'fill'}});
  await tools.execute('browser_click',{...common,ref:'e3'});assert.equal(client.calls.at(-1).data.action,'click');
  await tools.execute('browser_press',{...common,ref:'e2',key:'Enter'});assert.equal(client.calls.at(-1).data.action,'press');
  await tools.execute('browser_scroll',{...common,deltaY:1200});assert.equal(client.calls.at(-1).data.action,'scroll');
  await tools.execute('browser_history',{...common,direction:'back'});assert.equal(client.calls.at(-1).data.action,'history');
  await tools.execute('browser_switch_tab',{sessionId:'fixture-session',tabId:'real-tab-id'});
  assert.deepEqual(client.calls.slice(-2).map(call=>call.operation),['activate-tab','observe']);
  const before=client.calls.length;
  for(const [name,args]of[
    ['browser_click',{...common,ref:'input#password'}],
    ['browser_fill',{...common,ref:'e2',text:'safe',script:'document.cookie'}],
    ['browser_press',{...common,ref:'e2',key:'Control+L'}],
    ['browser_scroll',{...common,deltaY:2001}],
    ['browser_history',{...common,direction:'javascript:alert(1)'}],
  ])await assert.rejects(tools.execute(name,args));
  assert.equal(client.calls.length,before);
  await tools.close();
});

async function appFixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hyper-persistent-browser-'));
  const client = fixtureClient(), app = await createApp({ dataDir: directory, port: 0, persistentBrowserClient: client, ...options });
  const address = await app.listen(), origin = `http://127.0.0.1:${address.port}`; let cookie, csrf;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, method = 'GET', body, headers = {}) => fetch(origin + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const setup = async () => { const response = await call('/api/setup', 'POST', { password: 'isolated-browser-fixture-password' }); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = (await response.json()).csrfToken; };
  const save = async state => { const current = await (await call('/api/state')).json(); const response = await call('/api/state', 'PUT', { state }, { 'If-Match': String(current.revision) }); assert.equal(response.status, 200); };
  return { app, call, setup, save, client };
}

test('legacy browser API authenticates and validates workspace before deriving private server scope', async t => {
  const f = await appFixture(t);
  assert.equal((await f.call('/api/browser/sessions?workspaceId=personal')).status, 401); assert.equal(f.client.calls.length, 0);
  await f.setup();
  assert.equal((await f.call('/api/browser/sessions', 'POST', { workspaceId: 'personal', url: 'https://www.jd.com/' }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.call('/api/browser/sessions?workspaceId=unknown')).status, 404);
  assert.equal((await f.call('/api/browser/sessions', 'POST', { workspaceId: 'personal', namespace: 'another-owner' })).status, 400);
  const response = await f.call('/api/browser/sessions?workspaceId=personal', 'POST', { workspaceId: 'personal', url: 'https://www.jd.com/' }, { 'X-Browser-Owner': 'attacker', 'X-Browser-Actor': 'agent', 'X-Browser-Run': 'fake-run' });
  assert.equal(response.status, 200);
  const call = f.client.calls.at(-1); assert.equal(call.owner, browserNamespace('personal')); assert.equal(call.path, '/api/browser/sessions'); assert.deepEqual(call.data, { url: 'https://www.jd.com/' });
});

test('managed model loop truly waits for handback and receives observation before its next turn', async t => {
  const privateClient = fixtureClient(); let modelCalls = 0, bindingRunId, otherDefinitions;
  const frame = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
  const toolResponse = (name, args) => new Response(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `fixture_call_${modelCalls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } });
  const f = await appFixture(t, { deepseekApiKey: 'isolated-provider-fixture', persistentBrowserClientFactory: ({ runId }) => { bindingRunId = runId; return privateClient; }, llmFetch: async (_url, init) => {
    modelCalls++; const body = JSON.parse(init.body);
    const projected=body.tools.filter(item=>item.function.name.startsWith('browser_'));
    if (modelCalls === 1) {
      assert.deepEqual(projected.map(item=>item.function.name),['browser_session']);assert.deepEqual(projected[0].function.parameters.properties.action.enum,['create']);
      otherDefinitions=body.tools.filter(item=>!item.function.name.startsWith('browser_'));
      return toolResponse('browser_session', { action: 'create', url: 'https://www.jd.com/' });
    }
    assert.deepEqual(body.tools.filter(item=>!item.function.name.startsWith('browser_')),otherDefinitions);
    assert.ok(projected.some(item=>item.function.name==='browser_request_takeover'));
    for(const item of projected)assert.deepEqual(item.function.parameters.properties.sessionId.enum,['fixture-session']);
    assert.ok(!projected.some(item=>item.function.name==='browser_wait_for_handback'));
    if (modelCalls === 2) return toolResponse('browser_request_takeover', { sessionId: 'fixture-session' });
    assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('Fixture JD page after explicit handback')));
    return new Response(frame({ choices: [{ delta: { content: '交还后读取到真实fixture页面观察。' }, finish_reason: 'stop' }] }) + frame('[DONE]'), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  await f.setup(); const state = emptyState(); state.workspaces[0].data.threads.push({ id: 'browser-thread', title: 'Browser fixture', summary: '', time: '', config: { model: 'deepseek-flash', provider: 'Any', reasoning: 'Medium', mode: 'Execute', tools: ['Browser'] }, messages: [{ id: 'browser-message', role: 'user', text: '打开京东，等我接管登录后交还再读取页面。' }] }); await f.save(state);
  const created = await f.call('/api/runs', 'POST', { workspaceId: 'personal', threadId: 'browser-thread', userMessageId: 'browser-message' }); assert.equal(created.status, 202); const id = (await created.json()).run.id;
  await eventually(() => privateClient.calls.some(call => call.operation === 'waitForHandback'));
  assert.equal(bindingRunId, id); assert.equal(modelCalls, 2); await sleep(20); assert.equal(modelCalls, 2);
  const waitingEvents=await(await f.call(`/api/runs/${id}/events?workspaceId=personal&threadId=browser-thread`)).json();
  assert.deepEqual(waitingEvents.events.filter(item=>item.event.type==='browser_handoff').map(item=>item.event),[{type:'browser_handoff',status:'waiting',sessionId:'fixture-session',epoch:2}]);
  // A new viewer replays the same saved wait, without another model request.
  const replay=await(await f.call(`/api/runs/${id}/events?workspaceId=personal&threadId=browser-thread`)).json();
  assert.ok(replay.events.some(item=>item.event.type==='browser_handoff'&&item.event.sessionId==='fixture-session'));assert.equal(modelCalls,2);
  privateClient.handback();
  await eventually(async () => (await (await f.call(`/api/runs/${id}?workspaceId=personal&threadId=browser-thread`)).json()).run.status === 'succeeded');
  assert.equal(modelCalls, 3); assert.ok(privateClient.calls.some(call => call.operation === 'release')); assert.equal(privateClient.calls.some(call => call.operation === 'close'), false);
  const resumedEvents=await(await f.call(`/api/runs/${id}/events?workspaceId=personal&threadId=browser-thread`)).json();
  assert.deepEqual(resumedEvents.events.filter(item=>item.event.type==='browser_handoff').map(item=>item.event.status),['waiting','resumed']);
});

test('a new managed run connects to actual human control and waits without requesting takeover or changing the user epoch',async t=>{
  const client=fixtureClient({control:'human',epoch:6});let modelCalls=0;
  const frame=value=>'data: '+(typeof value==='string'?value:JSON.stringify(value))+'\n\n';
  const tool=(name,args)=>new Response(frame({choices:[{delta:{tool_calls:[{index:0,id:'resume-human-'+modelCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}});
  const f=await appFixture(t,{deepseekApiKey:'isolated-human-reconnect-provider',persistentBrowserClient:client,llmFetch:async(_url,init)=>{
    modelCalls++;const body=JSON.parse(init.body),browser=body.tools.filter(item=>item.function.name.startsWith('browser_'));
    if(modelCalls===1)return tool('browser_session',{action:'create'});
    if(modelCalls===2){assert.deepEqual(browser.map(item=>item.function.name),['browser_wait_for_handback']);assert.equal(browser[0].function.parameters.properties.timeoutSeconds,undefined);assert.deepEqual(browser[0].function.parameters.properties.sessionId.enum,['fixture-session']);return tool('browser_wait_for_handback',{sessionId:'fixture-session'});}
    assert.ok(browser.some(item=>item.function.name==='browser_observe'));assert.ok(!browser.some(item=>item.function.name==='browser_wait_for_handback'));
    assert.ok(body.messages.some(message=>message.role==='tool'&&message.content.includes('Fixture JD page after explicit handback')));
    return new Response(frame({choices:[{delta:{content:'明确交还后读取到已保存的实际页面。'},finish_reason:'stop'}]})+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}});
  }});
  await f.setup();const state=emptyState();state.workspaces[0].data.threads.push({id:'human-reconnect-thread',title:'Resume existing human control',summary:'',time:'',config:{model:'deepseek-flash',provider:'Any',reasoning:'Medium',mode:'Execute',tools:['Browser']},messages:[{id:'human-reconnect-message',role:'user',text:'连接现有浏览器，等我明确交还后继续。'}]});await f.save(state);
  const response=await f.call('/api/runs','POST',{workspaceId:'personal',threadId:'human-reconnect-thread',userMessageId:'human-reconnect-message'});assert.equal(response.status,202);const id=(await response.json()).run.id;
  await eventually(()=>client.calls.some(call=>call.operation==='waitForHandback'));assert.equal(modelCalls,2);
  assert.equal(client.calls.find(call=>call.operation==='waitForHandback').afterEpoch,6);assert.equal(client.calls.find(call=>call.operation==='waitForHandback').timeoutMs,1800000);assert.ok(!client.calls.some(call=>call.operation==='requestTakeover'));
  const events=(await(await f.call(`/api/runs/${id}/events?workspaceId=personal&threadId=human-reconnect-thread`)).json()).events;
  assert.ok(events.some(item=>item.event.type==='browser_handoff'&&item.event.status==='waiting'&&item.event.epoch===6));
  client.handback();await eventually(async()=>(await(await f.call(`/api/runs/${id}?workspaceId=personal&threadId=human-reconnect-thread`)).json()).run.status==='succeeded');
  assert.equal(modelCalls,3);assert.ok(!client.calls.some(call=>call.operation==='requestTakeover'));
});

test('unconfirmed handback ends the managed run without a later model call', async t => {
  const client=fixtureClient();client.waitForHandback=async()=>{throw Error('isolated handback timeout');};let modelCalls=0;
  const frame=value=>'data: '+(typeof value==='string'?value:JSON.stringify(value))+'\n\n';
  const f=await appFixture(t,{deepseekApiKey:'isolated-provider-fixture',persistentBrowserClientFactory:()=>client,llmFetch:async()=>{
    modelCalls++;const name=modelCalls===1?'browser_session':'browser_request_takeover',args=modelCalls===1?{action:'create'}:{sessionId:'fixture-session'};
    return new Response(frame({choices:[{delta:{tool_calls:[{index:0,id:'timeout_call_'+modelCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}});
  }});
  await f.setup();const state=emptyState();state.workspaces[0].data.threads.push({id:'handoff-timeout-thread',title:'Timeout fixture',summary:'',time:'',config:{model:'deepseek-flash',provider:'Any',reasoning:'Medium',mode:'Execute',tools:['Browser']},messages:[{id:'handoff-timeout-message',role:'user',text:'等待人工操作。'}]});await f.save(state);
  const response=await f.call('/api/runs','POST',{workspaceId:'personal',threadId:'handoff-timeout-thread',userMessageId:'handoff-timeout-message'});const id=(await response.json()).run.id;
  let run;await eventually(async()=>{run=(await(await f.call(`/api/runs/${id}?workspaceId=personal&threadId=handoff-timeout-thread`)).json()).run;return run.status==='failed';});
  assert.equal(modelCalls,2);assert.match(run.error,/handback was not confirmed/);assert.ok(client.calls.some(call=>call.operation==='release'));assert.equal(client.calls.some(call=>call.operation==='close'),false);
});
