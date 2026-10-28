import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.mjs';
import { buildConversation, MODELS, parseSSE } from './llm.mjs';
import { emptyState } from './validation.mjs';

const request = {workspaceId:'personal',threadId:'thread-1',userMessageId:'message-1'};
const thread = (id='thread-1') => ({id,title:'Test',summary:'',time:'',messages:[{id:'message-1',role:'user',text:'Saved question'}]});
const snapshot = () => { const s=emptyState();s.workspaces[0].data.threads.push(thread());return s; };
const frame = value => 'data: '+(typeof value==='string'?value:JSON.stringify(value))+'\r\n\r\n';
const chunk = (text,field='content') => ({choices:[{delta:{[field]:text}}]});
const success = () => new Response(frame(chunk('Hello'))+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}});
const events = text => text.split(/\n\n/).filter(Boolean).map(line=>JSON.parse(line.slice(6)));
async function harness(t, options={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'llm-backend-'));
  const app=await createApp({dataDir:dir,port:0,...options});
  const addr=await app.listen(),base=`http://127.0.0.1:${addr.port}`;
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  let cookie,csrf;
  const call=(route,opts={})=>fetch(base+route,{...opts,headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(opts.body!==undefined?{'Content-Type':'application/json'}:{}),...opts.headers},body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
  async function setup() {const r=await call('/api/setup',{method:'POST',body:{password:'local-testing-password'}});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).csrfToken;}
  async function save(state=snapshot()) {const current=await (await call('/api/state')).json();const r=await call('/api/state',{method:'PUT',headers:{'If-Match':String(current.revision)},body:{state}});assert.equal(r.status,200,await r.text());}
  return {call,setup,save,upload:async(workspaceId,name,mimeType,text)=>{
    const res=await fetch(base+'/api/files?workspaceId='+workspaceId,{method:'POST',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'X-File-Name':encodeURIComponent(name),'Content-Type':mimeType},body:text});
    assert.equal(res.status,201);return (await res.json()).file;
  },chat:(body=request,opts={})=>call('/api/llm/chat',{method:'POST',body,...opts})};
}

test('config has a fixed model allowlist; auth, origin and CSRF precede execution',async t=>{
  let calls=0;
  const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:()=>{calls++;return success();}});
  assert.equal((await h.call('/api/llm/config')).status,401);
  assert.equal((await h.chat()).status,401);
  await h.setup();await h.save();
  assert.deepEqual(await (await h.call('/api/llm/config')).json(),{configured:true,models:[...MODELS]});
  assert.equal((await h.chat(request,{headers:{'X-CSRF-Token':'wrong'}})).status,403);
  assert.equal((await h.chat(request,{headers:{Origin:'https://evil.example'}})).status,403);
  for(const model of ['gpt-4','https://evil.example','deepseek-flash ',null])assert.equal((await h.chat({...request,model})).status,422);
  assert.equal((await h.chat({...request,messages:[]})).status,400);
  assert.equal(calls,0);
});

test('fetch injection does not bypass missing server key configuration',async t=>{
  let called=false;const h=await harness(t,{llmFetch:()=>{called=true;return success();}});
  await h.setup();await h.save();
  assert.deepEqual(await (await h.call('/api/llm/config')).json(),{configured:false,models:[...MODELS]});
  assert.equal((await h.chat()).status,503);assert.equal(called,false);
});

test('streams split UTF-8, reasoning and usage; fixed endpoint, server context, no backend writes',async t=>{
  let payload;
  const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:async(url,init)=>{
    assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(init.method,'POST');
    assert.equal(init.headers.Authorization,'Bearer test-only-placeholder');
    payload=JSON.parse(init.body);assert.equal(init.signal.aborted,false);
    const wire=new TextEncoder().encode(': comment\r\n'+frame(chunk('Thinking','reasoning_content'))+frame(chunk('Hello 🌍'))+frame({choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,secret:'omit'}})+frame('[DONE]'));
    let offset=0;return new Response(new ReadableStream({pull(c){if(offset===wire.length)return c.close();c.enqueue(wire.slice(offset,++offset));}}),{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
  }});
  await h.setup();await h.save();const before=await (await h.call('/api/state')).json();
  const response=await h.chat({...request,model:'deepseek-v4-pro'});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  assert.deepEqual(events(await response.text()),[{type:'reasoning',text:'Thinking'},{type:'delta',text:'Hello 🌍'},{type:'done',model:'deepseek-v4-pro',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}]);
  assert.equal(payload.model,'deepseek-v4-pro');assert.equal(payload.max_tokens,8192);assert.equal(payload.stream,true);
  assert.equal(payload.messages.at(-1).content,'Saved question');assert.match(payload.messages[0].content,/no browser control, generic network browsing/);
  assert.equal(payload.tools,undefined);assert.doesNotMatch(JSON.stringify(payload),/test-only-placeholder/);
  assert.deepEqual(await (await h.call('/api/state')).json(),before);
  assert.equal((await h.chat()).status,409);
});

test('only the final saved user message can execute, and workspace-local references are re-resolved',async t=>{
  let calls=0;const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:()=>{calls++;return success();}});
  await h.setup();const s=snapshot();
  const foreign=emptyState().workspaces[0];foreign.id='foreign';foreign.name='Foreign';foreign.data.threads.push(thread('foreign-thread'));
  foreign.data.memories.push({id:'foreign-memory',content:'DO NOT LEAK',category:'fact',importance:3,pinned:true,tags:[]});s.workspaces.push(foreign);
  await h.save(s);
  assert.equal((await h.chat({...request,threadId:'foreign-thread'})).status,404);
  assert.equal((await h.chat({...request,workspaceId:'missing'})).status,404);
  assert.equal((await h.chat({...request,userMessageId:'not-saved'})).status,409);
  for(const [field,id] of [['memoryIds','foreign-memory'],['skillIds','foreign-skill'],['artifactIds','foreign-artifact']]){
    s.workspaces[0].data.threads[0].messages[0].context={[field]:[id]};await h.save(s);assert.equal((await h.chat()).status,422);
  }
  s.workspaces[0].data.threads[0].messages.push({id:'assistant-1',role:'assistant',text:'Already answered'});await h.save(s);assert.equal((await h.chat()).status,409);
  assert.equal(calls,0);
});

test('server context includes bounded local agent/skills/pinned and selected memories/project/artifact/text attachments',async()=>{
  const s=snapshot(),d=s.workspaces[0].data,t=d.threads[0];
  d.agents.push({id:'agent',name:'Agent',prompt:'Agent rules',skillIds:['skill'],model:'deepseek-v4-pro'});
  d.skills.push({id:'skill',name:'Skill',documentation:'Skill rules'});
  d.memories.push({id:'pinned',content:'Pinned fact',pinned:true},{id:'chosen',content:'Chosen fact',pinned:false},{id:'other',content:'Unselected fact',pinned:false});
  d.projects.push({id:'project',name:'Project',description:'Project description',goal:'Goal'});
  d.artifacts.push({id:'artifact',title:'Artifact',content:'Artifact text'});
  t.messages[0].context={settings:{agentId:'agent'},memoryIds:['chosen'],projectId:'project',artifactIds:['artifact'],attachments:[{name:'note.txt',workspaceId:'personal'}]};
  const c=await buildConversation(s,request,async(f,w)=>{assert.equal(w,'personal');return 'Readable text';});
  const text=JSON.stringify(c.messages);for(const value of ['Agent rules','Skill rules','Pinned fact','Chosen fact','Project description','Artifact text','Readable text'])assert.ok(text.includes(value),value);
  assert.doesNotMatch(text,/Unselected fact/);assert.equal(c.model,'deepseek-v4-pro');
  t.messages=Array.from({length:100},(_,i)=>({id:'m-'+i,role:i%2?'user':'assistant',text:'x'.repeat(16000)}));
  const bounded=await buildConversation(s,{...request,userMessageId:'m-99'});assert.ok(bounded.messages.length<=41);assert.ok(JSON.stringify(bounded).length<70000);
  t.messages.at(-1).text='x'.repeat(16001);await assert.rejects(buildConversation(s,{...request,userMessageId:'m-99'}),e=>e.status===413);
});

test('provider errors, malformed/truncated streams and unsupported tool calls are sanitized SSE errors',async t=>{
  const responses=[()=>new Response('secret upstream message',{status:401}),()=>{throw Error('secret credential failure');},()=>new Response('not SSE'),()=>new Response(frame(chunk('partial')),{headers:{'Content-Type':'text/event-stream'}}),()=>new Response('data: invalid-json\n\n',{headers:{'Content-Type':'text/event-stream'}}),()=>new Response(frame({choices:[{delta:{tool_calls:[{}]}}]})+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}})];
  const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:()=>responses.shift()()});await h.setup();await h.save();
  while(responses.length){const res=await h.chat();assert.equal(res.status,200);const text=await res.text(),e=events(text);assert.equal(e.at(-1).type,'error');assert.ok(!e.some(v=>v.type==='done'));assert.doesNotMatch(text,/secret|credential|invalid-json|test-only-placeholder/);}
});

test('disconnect aborts provider and releases per-thread and process concurrency admission',async t=>{
  const signals=[];
  const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:async(url,init)=>{
    signals.push(init.signal);return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame(chunk('start'))));init.signal.addEventListener('abort',()=>{try{c.close();}catch{}},{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  await h.setup();const s=snapshot();s.workspaces[0].data.threads.push(thread('thread-2'),thread('thread-3'));await h.save(s);
  const first=await h.chat();const reader=first.body.getReader();await reader.read();
  assert.equal((await h.chat()).status,409);
  const second=await h.chat({...request,threadId:'thread-2'});const reader2=second.body.getReader();await reader2.read();
  const busy=await h.chat({...request,threadId:'thread-3'});assert.equal(busy.status,429);assert.equal(busy.headers.get('retry-after'),'60');
  await reader.cancel();await reader2.cancel();
  // Wait on the actual server cancellation signals, not an arbitrary sleep.
  await Promise.all(signals.map(signal=>signal.aborted?undefined:new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))));
  assert.ok(signals.every(s=>s.aborted));
  const retry=await h.chat();assert.equal(retry.status,200);await retry.body.cancel();
});

test('rate limit remains bounded after failed provider requests',async t=>{
  let calls=0;const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:()=>{calls++;throw Error('offline');}});await h.setup();await h.save();
  for(let i=0;i<20;i++)assert.equal(events(await (await h.chat()).text()).at(-1).type,'error');
  assert.equal((await h.chat()).status,429);assert.equal(calls,20);
});

test('SSE decoder supports multiline data and rejects oversized events',async()=>{
  const signal=new AbortController().signal;
  async function decode(text){const values=[];for await(const value of parseSSE(new Response(text).body.getReader(),signal))values.push(value);return values;}
  assert.deepEqual(await decode(': ignore\rdata: first\rdata: second\r\r'),['first\nsecond']);
  await assert.rejects(decode('data: '+'x'.repeat(65537)+'\n\n'),/limit/);
});


test('real saved text attachments are read only through workspace-owned metadata; binary stays unavailable',async t=>{
  let payload;
  const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:async(url,init)=>{payload=JSON.parse(init.body);return success();}});
  await h.setup();const s=snapshot(),foreign=emptyState().workspaces[0];foreign.id='foreign';s.workspaces.push(foreign);await h.save(s);
  const local=await h.upload('personal','notes.txt','text/plain','LOCAL ATTACHMENT TEXT');
  const binary=await h.upload('personal','image.png','image/png',new Uint8Array([0,255,10,100]));
  const foreignFile=await h.upload('foreign','foreign.txt','text/plain','FOREIGN ATTACHMENT SECRET');
  s.workspaces[0].data.threads[0].messages[0].context={attachments:[local,binary]};await h.save(s);
  await (await h.chat()).text();
  const prompt=JSON.stringify(payload.messages);assert.match(prompt,/LOCAL ATTACHMENT TEXT/);assert.match(prompt,/content unavailable/);assert.doesNotMatch(prompt,/FOREIGN ATTACHMENT SECRET/);
  // Historical metadata cannot relabel a file owned by another workspace.
  s.workspaces[0].data.threads[0].messages[0].context={attachments:[{...foreignFile,workspaceId:'personal'}]};
  const current=await (await h.call('/api/state')).json();
  assert.equal((await h.call('/api/state',{method:'PUT',headers:{'If-Match':String(current.revision)},body:{state:s}})).status,422);
});

test('oversized provider output is stopped with a sanitized error and no done event',async t=>{
  const wire=Array.from({length:6},()=>frame(chunk('x'.repeat(60000)))).join('')+frame('[DONE]');
  const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:()=>new Response(wire,{headers:{'Content-Type':'text/event-stream'}})});
  await h.setup();await h.save();const result=events(await (await h.chat()).text());
  assert.equal(result.at(-1).type,'error');assert.ok(result.filter(e=>e.type==='delta').reduce((n,e)=>n+e.text.length,0)<=256*1024);assert.ok(!result.some(e=>e.type==='done'));
});


test('current provider models, effort and output preferences are applied to real request fields',async()=>{
  const s=snapshot(), t=s.workspaces[0].data.threads[0];
  t.config={model:'deepseek-v4-pro',reasoning:'High',provider:'DeepSeek',mode:'Plan first',tools:[],outputFormat:'Webpage'};
  const c=await buildConversation(s,request);
  assert.equal(c.model,'deepseek-v4-pro');assert.equal(c.reasoning_effort,'max');assert.deepEqual(c.thinking,{type:'enabled'});
  assert.match(c.messages[0].content,/complete standalone HTML/);assert.match(c.messages[0].content,/give a plan first/);
  t.config.reasoning='Low';assert.equal((await buildConversation(s,request)).reasoning_effort,'low');
});

test('tool loop executes search, creates and updates real artifact data, and passes results back to provider',async t=>{
  let round=0,documentId;
  const tool=(id,name,args,index=0)=>({index,id,type:'function',function:{name,arguments:JSON.stringify(args)}});
  const toolResponse=calls=>new Response(frame({choices:[{delta:{tool_calls:calls},finish_reason:'tool_calls'}]})+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}});
  const h=await harness(t,{deepseekApiKey:'test-only-placeholder',llmFetch:async(_url,init)=>{
    const body=JSON.parse(init.body);round++;
    assert.ok(body.tools.some(t=>t.function.name==='workspace_search'));
    if(round===1)return toolResponse([tool('call-search','workspace_search',{query:'Test'}),tool('call-doc','create_artifact',{title:'Tool document',kind:'Document',content:'# Version one'},1)]);
    const results=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
    if(round===2){documentId=results.find(r=>r.id)?.id;assert.ok(documentId);return toolResponse([tool('call-update','update_artifact',{id:documentId,content:'# Version two'}),tool('call-table','create_table',{title:'Tool table',columns:['Name','Value'],rows:[['A','1']]},1)]);}
    assert.ok(results.length>=4);return success();
  }});
  await h.setup();const s=snapshot();s.workspaces[0].data.threads[0].config={model:'deepseek-flash',reasoning:'Low',provider:'DeepSeek',mode:'Execute',tools:['Thread Search','Documents','Tables']};await h.save(s);
  const response=await h.chat();assert.equal(response.status,200);const result=events(await response.text());
  assert.equal(round,3);assert.equal(result.filter(e=>e.type==='tool' && e.status==='success').length,4);
  const artifacts=result.filter(e=>e.type==='artifact').map(e=>e.patch.artifact);
  assert.equal(artifacts.length,2);const doc=artifacts.find(a=>a.kind==='Document');assert.equal(doc.id,documentId);assert.equal(doc.content,'# Version two');assert.ok(doc.versions.some(v=>v.content==='# Version one'));
  const table=artifacts.find(a=>a.kind==='Table');assert.deepEqual(JSON.parse(table.content),{columns:['Name','Value'],rows:[['A','1']]});
  assert.equal(result.at(-1).type,'done');
  // Client applies these exact patches through the existing authenticated revision-checked API.
  const current=await (await h.call('/api/state')).json();current.state.workspaces[0].data.artifacts.push(...artifacts);await h.save(current.state);
  assert.equal((await (await h.call('/api/state')).json()).state.workspaces[0].data.artifacts.length,2);
});

test('selected installed weather skill exposes and executes an actual API adapter through model tool loop',async t=>{
  const {marketplaceCatalog}=await import('./marketplace.mjs');
  const source=marketplaceCatalog.entries.find(e=>e.name==='US National Weather Service API');let round=0,network=0;
  const h=await harness(t,{deepseekApiKey:'test-only-placeholder',publicUserAgent:'Hyperagents-Test/1.0',publicFetch:async url=>{
    network++;
    if(String(url).includes('/points/'))return new Response(JSON.stringify({properties:{forecast:'https://api.weather.gov/gridpoints/LWX/97,71/forecast',relativeLocation:{properties:{city:'Washington',state:'DC'}}}}),{headers:{'content-type':'application/geo+json'}});
    return new Response(JSON.stringify({properties:{updated:'2026-10-28T09:00:00Z',units:'us',periods:[{number:1,name:'Today',startTime:'2026-10-28T06:00:00-04:00',endTime:'2026-10-28T18:00:00-04:00',temperature:69,temperatureUnit:'F',shortForecast:'Partly sunny'}]}}),{headers:{'content-type':'application/geo+json'}});
  },llmFetch:async(_url,init)=>{
    const body=JSON.parse(init.body);round++;assert.ok(body.tools.some(t=>t.function.name==='weather_forecast'));
    if(round===1)return new Response(frame({choices:[{delta:{tool_calls:[{index:0,id:'call-weather',type:'function',function:{name:'weather_forecast',arguments:JSON.stringify({latitude:38.8977,longitude:-77.0365})}}]},finish_reason:'tool_calls'}]})+frame('[DONE]'),{headers:{'content-type':'text/event-stream'}});
    assert.equal(JSON.parse(body.messages.find(m=>m.role==='tool').content).service,'Weather');return success();
  }});
  await h.setup();const s=snapshot(),d=s.workspaces[0].data;
  d.skills.push({id:'installed-weather',sourceId:source.sourceId,name:source.name,description:source.summary,documentation:source.implementation.documentation,whenToUse:'Forecast',author:'Independent replica implementation',tags:source.categories,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  d.threads[0].messages[0].context={skillIds:['installed-weather']};await h.save(s);
  const res=await h.chat();const result=events(await res.text());assert.equal(network,2);assert.equal(round,2);assert.equal(result.at(-1).type,'done',JSON.stringify(result));assert.ok(result.some(e=>e.type==='tool' && e.name==='weather_forecast' && e.status==='success'));
});
