import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createIntegrationRegistry,captureIntegrationCredentials} from './integrations.mjs';
import {createApprovalBroker} from './integration-approvals.mjs';
import {createApp} from './app.mjs';
import {emptyState} from './validation.mjs';
const key='synthetic-integration-token-only';
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
function snapshot(){const state=emptyState(),data=state.workspaces[0].data;data.connections.push({id:'conn-github',provider:'GitHub',label:'Test GitHub',endpoint:'https://api.github.com',createdAt:new Date().toISOString(),enabled:true});data.threads.push({id:'thread-1',title:'API task',summary:'',time:'',messages:[{id:'message-1',role:'user',text:'Read my repositories',context:{integrationIds:['conn-github']}}]});return state;}
const request={workspaceId:'personal',threadId:'thread-1',userMessageId:'message-1'};
test('registry reports 13 implemented provider APIs and never returns credentials',()=>{const registry=createIntegrationRegistry({credentials:{GITHUB_TOKEN:key}});const result=registry.statuses();assert.equal(result.providers.length,13);assert.equal(result.providers.find(p=>p.id==='github').configured,true);assert.equal(result.providers.find(p=>p.id==='slack').configured,false);assert.doesNotMatch(JSON.stringify(result),new RegExp(key));const env={GITHUB_TOKEN:key,SLACK_BOT_TOKEN:'synthetic-slack',OTHER:'keep'};assert.deepEqual(captureIntegrationCredentials(env),{GITHUB_TOKEN:key,SLACK_BOT_TOKEN:'synthetic-slack'});assert.deepEqual(env,{OTHER:'keep'});});
test('only selected enabled workspace bindings expose tools, and writes merely prepare approval',async()=>{let reads=0,writes=0;const registry=createIntegrationRegistry({credentials:{GITHUB_TOKEN:key},fetchImpl:async(url,init)=>{assert.equal(init.headers.Authorization,'Bearer '+key);if(init.method==='POST'){writes++;return json({number:1,title:'Approved issue',state:'open',html_url:'https://github.com/o/r/issues/1'});}reads++;return json([{id:1,name:'r',full_name:'o/r',private:true}]);}});const state=snapshot(),broker=createApprovalBroker({load:()=>({state}),registry}),bound=registry.bind(state,request,broker);
 assert.ok(bound.definitions.some(d=>d.function.name==='github_repositories'));assert.ok(bound.definitions.some(d=>d.function.name==='prepare_github_create_issue'));assert.equal(bound.definitions.some(d=>d.function.name==='github_create_issue'),false);
 const r=await bound.execute('github_repositories',{connectionId:'conn-github'});assert.equal(r.result.repositories[0].fullName,'o/r');assert.equal(reads,1);
 const prepared=await bound.execute('prepare_github_create_issue',{connectionId:'conn-github',owner:'o',repo:'r',title:'Approved issue',body:'Test body'});assert.equal(writes,0);assert.equal(prepared.result.status,'approval_required');assert.ok(prepared.approval.token);await broker.execute(prepared.approval.token,{workspaceId:"personal",threadId:"thread-1"});assert.equal(writes,1);
 await assert.rejects(bound.execute('github_repositories',{connectionId:'foreign'}));
 state.workspaces[0].data.threads[0].messages[0].context.integrationIds=[];assert.equal(registry.bind(state,request,broker).definitions.length,0);
 state.workspaces[0].data.threads[0].messages[0].context.integrationIds=['conn-github'];state.workspaces[0].data.connections[0].enabled=false;assert.throws(()=>registry.bind(state,request,broker),/disabled/);
});
test('authenticated API test and execution endpoints enforce CSRF and explicit confirmation',async t=>{const dir=await mkdtemp(path.join(tmpdir(),'integration-api-'));let reads=0;const app=await createApp({dataDir:dir,port:0,integrationCredentials:{GITHUB_TOKEN:key},integrationFetch:async(url)=>{reads++;assert.equal(new URL(url).pathname,'/user');return json({login:'verified-owner'});}});await app.listen();t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});const base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(base+'/api/integrations')).status,401);
 const setup=await fetch(base+'/api/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password:'integration-test-password'})});const cookie=setup.headers.get('set-cookie').split(';')[0],csrf=(await setup.json()).csrfToken;
 const headers={Origin:base,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf};
 const status=await(await fetch(base+'/api/integrations',{headers:{Cookie:cookie}})).json();assert.equal(status.providers.length,13);assert.doesNotMatch(JSON.stringify(status),new RegExp(key));
 assert.equal((await fetch(base+'/api/integrations/github/test',{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},body:JSON.stringify({workspaceId:'personal'})})).status,403);assert.equal(reads,0);
 const verified=await(await fetch(base+'/api/integrations/github/test',{method:'POST',headers,body:JSON.stringify({workspaceId:'personal'})})).json();assert.equal(verified.accountLabel,'verified-owner');assert.equal(reads,1);
 assert.equal((await fetch(base+'/api/integrations/execute',{method:'POST',headers,body:JSON.stringify({token:'invalid',confirmed:false})})).status,422);
 const missing=await fetch(base+'/api/integrations/slack/test',{method:'POST',headers,body:JSON.stringify({workspaceId:'personal'})});assert.equal(missing.status,422);assert.equal(reads,1);
});

test('registry-to-fetch JSON contract serializes Telegram, Linear and Asana bodies exactly once',async()=>{
 let calls=0;const registry=createIntegrationRegistry({credentials:{TELEGRAM_BOT_TOKEN:'12345:ABCDEFGHIJKLMNOPQRSTUV',LINEAR_API_KEY:'synthetic-linear-key',ASANA_TOKEN:'synthetic-asana-key'},fetchImpl:async(url,init)=>{
  calls++;assert.equal(init.method,'POST');const body=JSON.parse(init.body);assert.equal(typeof body,'object');assert.notEqual(body,null);
  if(url.includes('telegram.org')){assert.equal(body.limit,20);return json({ok:true,result:[]});}
  if(url.includes('linear.app')){assert.equal(typeof body.query,'string');return json({data:{viewer:{id:'viewer-id',name:'Test Viewer'}}});}
  assert.deepEqual(body.data.projects,['1234']);return json({data:{gid:'99',name:'Approved task',completed:false}});
 }});
 await registry.provider('telegram').run('telegram_updates',{});await registry.provider('linear').test();await registry.provider('asana').run('asana_create_task',{projectId:'1234',name:'Approved task',notes:'Approved notes'});assert.equal(calls,3);
});
test('a live disabled binding revokes reads in a generation bound to an older snapshot',async()=>{
 let calls=0;const live=snapshot(),registry=createIntegrationRegistry({credentials:{GITHUB_TOKEN:key},load:()=>({state:live}),fetchImpl:async()=>{calls++;return json([]);}}),broker=createApprovalBroker({load:()=>({state:live}),registry}),bound=registry.bind(structuredClone(live),request,broker);
 live.workspaces[0].data.connections[0].enabled=false;await assert.rejects(bound.execute('github_repositories',{connectionId:'conn-github'}),/binding changed/);assert.equal(calls,0);
});
