import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from './app.mjs';
import {emptyState} from './validation.mjs';
const frame=o=>'data: '+(typeof o==='string'?o:JSON.stringify(o))+'\n\n';
test('managed plan steps and aggregate model usage are durable, with no shell exposure in Plan mode',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'agent-plan-'));let turns=0;
  const steps=[{id:'inspect',title:'Inspect the input',status:'completed'},{id:'answer',title:'Write a short answer',status:'in_progress'}];
  const app=await createApp({dataDir:dir,shellRoot:dir,port:0,deepseekApiKey:'synthetic-test-key',llmFetch:async(_url,init)=>{
    const request=JSON.parse(init.body);turns++;
    assert.deepEqual(request.tools.map(t=>t.function.name),['update_plan']);
    const data=turns===1?{choices:[{delta:{tool_calls:[{index:0,id:'plan1',type:'function',function:{name:'update_plan',arguments:JSON.stringify({steps})}}]},finish_reason:'tool_calls'}]}:{choices:[{delta:{content:'Planned answer'}}]};
    return new Response(frame(data)+frame({choices:[],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}});
  }});
  await app.listen();const base='http://127.0.0.1:'+app.server.address().port;let cookie,csrf;
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const call=(url,method='GET',body,headers={})=>fetch(base+url,{method,headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const setup=await call('/api/setup','POST',{password:'synthetic-test-password'});cookie=setup.headers.get('set-cookie').split(';')[0];csrf=(await setup.json()).csrfToken;
  const state=emptyState();state.workspaces[0].data.threads.push({id:'t1',title:'Plan test',summary:'',time:'',config:{model:'deepseek-flash',provider:'DeepSeek',reasoning:'Low',mode:'Plan',tools:['Shell','Documents']},messages:[{id:'u1',role:'user',text:'Plan a task'}]});
  assert.equal((await call('/api/state','PUT',{state},{'If-Match':'0'})).status,200);
  const {run}=await(await call('/api/runs','POST',{workspaceId:'personal',threadId:'t1',userMessageId:'u1'})).json();let view;
  for(let i=0;i<200;i++){view=await(await call('/api/runs/'+run.id+'/events')).json();if(['succeeded','failed'].includes(view.run.status))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(view.run.status,'succeeded');assert.deepEqual(view.run.plan,steps);assert.equal(view.run.toolCount,1);
  assert.deepEqual(view.run.usage,{prompt_tokens:20,completion_tokens:6,total_tokens:26});
  assert.ok(view.events.some(e=>e.event.type==='plan'));assert.equal(view.run.resultSaved,true);
});
