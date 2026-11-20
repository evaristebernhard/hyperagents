// Explicit live inference acceptance. No old owner data, no fallback provider.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { emptyState } from '../server/validation.mjs';
import { loadScnetAgentConfig } from '../server/scnet-agent-model.mjs';

if (!process.env.HYPERAGENTS_SCNET_ENV_FILE) throw Error('Explicit finite DCU configuration path is required.');
const config=loadScnetAgentConfig();
assert.ok(config);
const dataDir=await mkdtemp(join(tmpdir(),'hyperagent-real-dcu-'));
const report={startedAt:new Date().toISOString(),scope:'Real SCNet DCU inference through authenticated Hyperagent managed runs with a temporary owner/SQLite; no provider mocks or production owner data.',
  model:config.model,provider:'SCNet DCU',checks:[],upstreamRequests:[],toolScope:'No tools for this bounded persistence/persona acceptance; browser tool execution is verified separately.'};
let app,base,cookie,csrf;
async function start(){
  app=await createApp({port:0,dataDir,scnetModelConfig:{...config,toolAllowlist:[]},runTimeoutMs:110000,
    llmFetch:async(url,init)=>{assert.equal(url,config.baseUrl+'/chat/completions');const body=JSON.parse(init.body);
      const item={number:report.upstreamRequests.length+1,stream:body.stream===true,inputBytes:Buffer.byteLength(JSON.stringify(body.messages))};
      assert.ok(item.number<=3,'Bounded live request count');report.upstreamRequests.push(item);
      const response=await fetch(url,init);item.status=response.status;return response;}});
  base=`http://127.0.0.1:${(await app.listen()).port}`;
}
async function call(route,method='GET',body,extra={}){
  const response=await fetch(base+route,{method,signal:AbortSignal.timeout(120000),headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),
    ...(body?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
  return response;
}
async function state(){const response=await call('/api/state');assert.equal(response.status,200);return response.json();}
async function run(question){
  const saved=await state(),thread=saved.state.workspaces[0].data.threads[0];
  const id=randomUUID();thread.messages.push({id,role:'user',text:question,createdAt:new Date().toISOString()});
  assert.equal((await call('/api/state','PUT',{state:saved.state},{'If-Match':String(saved.revision)})).status,200);
  const accepted=await call('/api/runs','POST',{workspaceId:'personal',threadId:thread.id,userMessageId:id});assert.equal(accepted.status,202);
  const info=(await accepted.json()).run;
  const started=Date.now();let current;
  while(Date.now()-started<110000){
    const response=await call(`/api/runs/${info.id}?workspaceId=personal&threadId=${thread.id}`);assert.equal(response.status,200);current=(await response.json()).run;
    if(['succeeded','failed','cancelled','interrupted'].includes(current.status))break;
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  assert.equal(current.status,'succeeded',JSON.stringify({status:current.status,error:current.error}));assert.equal(current.resultSaved,true);
  const after=await state(),answer=after.state.workspaces[0].data.threads[0].messages.find(message=>message.id==='run-answer-'+info.id);
  assert.ok(answer?.text?.trim());assert.equal(answer.knowledgeHints.memorySnapshots[0].content,'我喜欢乌龙茶，不加糖。');
  const events=await(await call(`/api/runs/${info.id}/events?workspaceId=personal&threadId=${thread.id}`)).json();
  assert.ok(events.events.length>0);
  return{runId:info.id,status:current.status,answer:answer.text,memorySnapshots:answer.knowledgeHints.memorySnapshots,eventCount:events.events.length,elapsedMs:Date.now()-started};
}
try{
  await start();const setup=await call('/api/setup','POST',{password:'isolated-live-'+randomUUID()});assert.equal(setup.status,200);
  cookie=setup.headers.get('set-cookie').split(';')[0];csrf=(await setup.json()).csrfToken;
  const initial=emptyState(),data=initial.workspaces[0].data,at=new Date().toISOString();
  data.agents.push({id:'companion',name:'小予',description:'真实DCU验收分身',prompt:'用一句自然中文回答，依据已确认的个人记忆，不编造。',companion:true,memoryReadScope:'all',tools:[]});
  data.threads.push({id:'self',title:'DCU真实自聊',summary:'',time:'刚刚',companionAgentId:'companion',messages:[],config:{model:config.model,provider:'SCNet DCU',mode:'Execute',reasoning:'Low',tools:[],agentId:'companion'}});
  data.memories.push({id:'tea',content:'我喜欢乌龙茶，不加糖。',category:'喜好',importance:3,pinned:false,
    companion:{agentId:'companion',status:'active',visibility:'private',createdAt:at,updatedAt:at}});
  assert.equal((await call('/api/state','PUT',{state:initial},{'If-Match':'0'})).status,200);
  report.first=await run('我喝茶有什么习惯？请按我的记忆回答一句。');
  assert.match(report.first.answer,/乌龙|不加糖|无糖/);
  report.checks.push('Real DCU answer uses supplied owner-confirmed tea memory');
  await app.close();app=null;await start();
  const restored=await state();assert.equal(restored.state.workspaces[0].data.memories[0].id,'tea');
  assert.ok(restored.state.workspaces[0].data.threads[0].messages.some(message=>message.text===report.first.answer));
  const oldRun=await(await call(`/api/runs/${report.first.runId}?workspaceId=personal&threadId=self`)).json();assert.equal(oldRun.run.status,'succeeded');
  report.checks.push('Owner session, companion, memory, final answer and run survive server close/reopen');
  report.followup=await run('继续刚才的聊天：我想喝茶，请按我的喜好给一个简短建议。');
  report.checks.push('New real DCU turn succeeds after server restart with preserved memory snapshot');
  report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{
  await app?.close();await rm(dataDir,{recursive:true,force:true});report.temporaryPrivateDataRemoved=true;report.finishedAt=new Date().toISOString();
  await mkdir(new URL('../docs/verification-browser-persistence/',import.meta.url),{recursive:true});
  await writeFile(new URL('../docs/verification-browser-persistence/dcu-live.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({phase:'live-host-finished',status:report.status,checks:report.checks.length,upstreamRequests:report.upstreamRequests.length,error:report.error}));
}
