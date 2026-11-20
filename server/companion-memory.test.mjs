import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_MEMORY_LIMITS, canReadCompanionMemory, canReadCompanionThread, selectCompanionMemories } from './companion-memory.mjs';
import { buildConversation } from './llm.mjs';
import { emptyState, validateState, validKnowledgeHints } from './validation.mjs';

const at='2026-11-11T12:00:00.000Z';
const settings=agentId=>({model:'deepseek-flash',reasoning:'Medium',provider:'DeepSeek',mode:'Chat',tools:[],agentId});
const agent=id=>({id,name:id,description:'Companion',prompt:'Use owner-confirmed background.',companion:true,memoryReadScope:'workspace'});
const memory=(id,agentId='agent-a',status='active',visibility='private',content=id+' 茶喝什么')=>({id,content,category:'喜好',importance:3,pinned:true,tags:[],companion:{agentId,status,visibility,createdAt:at,updatedAt:at}});
function snapshot() {
  const s=emptyState(),d=s.workspaces[0].data;
  d.agents.push(agent('agent-a'),agent('agent-b'));
  d.threads.push({id:'self-a',title:'My self-chat',summary:'',time:'',companionAgentId:'agent-a',config:settings('agent-a'),messages:[{id:'question',role:'user',text:'我想喝茶，推荐茶饮。'}]},
    {id:'normal',title:'Ordinary chat',summary:'',time:'',config:settings('agent-a'),messages:[{id:'normal-question',role:'user',text:'茶饮'}]});
  d.memories.push(memory('PRIVATE-A'),memory('SHARED-A','agent-a','active','shared'),memory('PENDING-A','agent-a','pending'),memory('REJECTED-A','agent-a','rejected'),memory('PRIVATE-B','agent-b'),memory('SHARED-B','agent-b','active','shared'));
  return s;
}
const request={workspaceId:'personal',threadId:'self-a',userMessageId:'question'};
const selected=state=>{const data=state.workspaces[0].data;return {data,thread:data.threads[0],agent:data.agents[0]};};

test('companion authority requires confirmation, matching agent and explicit self-chat for private memory',()=>{
  const s=snapshot(),{data,thread,agent}=selected(s),args={agent,thread,selectedMemoryIds:data.memories.map(m=>m.id)};
  assert.equal(canReadCompanionMemory(data.memories[0],args),true);
  assert.equal(canReadCompanionMemory(data.memories[1],{...args,thread:data.threads[1]}),true);
  for (const m of data.memories.slice(2)) assert.equal(canReadCompanionMemory(m,args),false,m.id);
  assert.equal(canReadCompanionMemory(data.memories[0],{...args,thread:data.threads[1]}),false);
  for(const roomId of ['room-a','']) assert.equal(canReadCompanionMemory(data.memories[0],{...args,thread:{...thread,roomId}}),false);
  assert.equal(canReadCompanionMemory(data.memories[0],{...args,selectedAgentId:'agent-b'}),false);
  assert.equal(canReadCompanionMemory(data.memories[0],{...args,agent:{...agent,companion:false}}),false);
  assert.equal(canReadCompanionThread(thread,{...args,thread:data.threads[1]}),false);
  assert.equal(canReadCompanionMemory({id:'legacy'},{}),true);
});

test('linked/off scope cannot be bypassed by pinning or selecting pending/rejected memories',()=>{
  const s=snapshot(),{data,thread,agent}=selected(s),m=data.memories[0];
  agent.memoryReadScope='linked';
  assert.equal(canReadCompanionMemory(m,{agent,thread}),false);
  assert.equal(canReadCompanionMemory(m,{agent,thread,selectedMemoryIds:[m.id]}),true);
  agent.memoryReadScope='off';
  for(const item of data.memories) assert.equal(canReadCompanionMemory(item,{agent,thread,selectedMemoryIds:data.memories.map(m=>m.id)}),false);
});

test('bounded retrieval chooses related or voice records and preserves UTF-8',()=>{
  const s=snapshot(),{data,thread,agent}=selected(s);
  data.memories=[memory('irrelevant','agent-a','active','private','我喜欢在公园散步。'),memory('voice','agent-a','active','private','请简洁温和地说话。'),...Array.from({length:12},(_,i)=>memory('tea-'+i,'agent-a','active','private','茶饮偏好：'+('乌龙茶🍵'.repeat(300))))];
  data.memories[1].category='口吻';
  const result=selectCompanionMemories(data.memories,{agent,thread,query:'我想喝茶'});
  assert.equal(result.length,COMPANION_MEMORY_LIMITS.items);
  assert.equal(result[0].memory.id,'voice');
  assert.ok(result.every(row=>row.memory.id!=='irrelevant' && Buffer.byteLength(row.content)<=COMPANION_MEMORY_LIMITS.itemBytes && !row.content.includes('\ufffd')));
  assert.ok(result.reduce((sum,row)=>sum+Buffer.byteLength(row.content)+80,0)<=COMPANION_MEMORY_LIMITS.bytes);
});

test('real conversation assembly includes only authorized active memories and exact supplied snapshots',async()=>{
  const s=snapshot(),{data,thread}=selected(s);
  thread.messages[0].context={memoryIds:data.memories.map(m=>m.id)};
  const result=await buildConversation(s,request),system=result.messages[0].content;
  assert.deepEqual(result.knowledgeHints.memoryIds,['PRIVATE-A','SHARED-A']);
  assert.equal(result.knowledgeHints.memorySnapshots.length,2);
  assert.equal(validKnowledgeHints(result.knowledgeHints),true);
  for(const item of result.knowledgeHints.memorySnapshots) assert.ok(system.includes(item.content));
  for(const forbidden of ['PENDING-A','REJECTED-A','PRIVATE-B','SHARED-B']) assert.ok(!system.includes(forbidden),forbidden);
  data.memories[0].companion.status='pending';
  const withdrawn=await buildConversation(s,request);
  assert.deepEqual(withdrawn.knowledgeHints.memoryIds,['SHARED-A']);
  assert.ok(!withdrawn.messages[0].content.includes('PRIVATE-A'));
  data.memories[1].companion.status='rejected';
  assert.deepEqual((await buildConversation(s,request)).knowledgeHints,{skillIds:[],memoryIds:[]});
});

test('ordinary threads and different selected agents never inherit private self-chat memory',async()=>{
  const s=snapshot(),{data}=selected(s),t=data.threads[1];
  t.messages[0].context={memoryIds:data.memories.map(m=>m.id)};
  const ordinary=await buildConversation(s,{...request,threadId:t.id,userMessageId:'normal-question'});
  assert.deepEqual(ordinary.knowledgeHints.memoryIds,['SHARED-A']);
  t.config.agentId='agent-b';
  assert.deepEqual((await buildConversation(s,{...request,threadId:t.id,userMessageId:'normal-question'})).knowledgeHints.memoryIds,['SHARED-B']);
  t.config.agentId=undefined;
  assert.deepEqual((await buildConversation(s,{...request,threadId:t.id,userMessageId:'normal-question'})).knowledgeHints.memoryIds,[]);
});

test('self-chat execution rejects agent switches, missing companion identity and room impersonation',async()=>{
  for(const mutate of [
    (d,t)=>{t.messages[0].context={settings:settings('agent-b')};},
    (d,t)=>{t.config.agentId='agent-b';},
    (d,t)=>{t.roomId='room';},
    d=>{d.agents[0].companion=false;},
  ]) {
    const s=snapshot(),{data,thread}=selected(s);mutate(data,thread);
    await assert.rejects(buildConversation(s,request),error=>error.status===422);
  }
});

test('foreign workspace memory references fail and private self-chat artifacts cannot be explicitly linked',async()=>{
  const s=snapshot(),{data}=selected(s),foreign=emptyState().workspaces[0];foreign.id='foreign';
  foreign.data.agents.push(agent('foreign-agent'));foreign.data.memories.push(memory('FOREIGN','foreign-agent'));
  s.workspaces.push(foreign);data.threads[0].messages[0].context={memoryIds:['FOREIGN']};
  await assert.rejects(buildConversation(s,request),error=>error.status===422);
  data.artifacts.push({id:'self-artifact',title:'Private saved answer',threadId:'self-a',content:'PRIVATE-ARTIFACT'});
  data.threads[1].messages[0].context={artifactIds:['self-artifact']};
  await assert.rejects(buildConversation(s,{...request,threadId:'normal',userMessageId:'normal-question'}),error=>error.status===422);
});

test('knowledge snapshots survive final context clipping and respect item limits',async()=>{
  const s=snapshot(),{data,thread}=selected(s);
  data.memories=[...Array.from({length:20},(_,index)=>memory('tea-'+index,'agent-a','active','private','乌龙茶🍵'.repeat(300))),...Array.from({length:20},(_,index)=>({id:'old-'+index,content:'LEGACY-'+index+' '+('L'.repeat(3000)),category:'fact',importance:3,pinned:true}))];
  data.skills.push({id:'long-skill',name:'Long skill',documentation:'s'.repeat(100000)});data.agents[0].skillIds=['long-skill'];thread.notes='n'.repeat(100000);
  const result=await buildConversation(s,request),system=result.messages[0].content;
  assert.equal(result.knowledgeHints.memorySnapshots.length,4);
  for(const item of result.knowledgeHints.memorySnapshots) assert.ok(system.includes(item.content));
  for(const id of result.knowledgeHints.memoryIds.filter(id=>id.startsWith('old-'))) assert.ok(system.includes('LEGACY-'+id.slice(4)));
});

test('companion metadata validates types, limits, self/agent references and historic source retention',()=>{
  const s=snapshot(),{data,thread}=selected(s),m=data.memories[0];
  m.companion.source={threadId:thread.id,messageId:'question',quote:'我想喝茶'};
  m.companion.history=[{action:'confirmed',content:m.content,status:'active',visibility:'private',at}];
  assert.equal(validateState(s),s);
  const invalids=[
    state=>{state.workspaces[0].data.agents[0].companion='yes';},
    state=>{state.workspaces[0].data.threads[0].config.agentId='agent-b';},
    state=>{state.workspaces[0].data.threads[0].roomId='room';state.workspaces[0].data.rooms.push({id:'room',name:'Room',topic:'',agentIds:['agent-a'],notes:[]});},
    state=>{state.workspaces[0].data.memories[0].companion.agentId='missing';},
    state=>{state.workspaces[0].data.memories[0].companion.status='complete';},
    state=>{state.workspaces[0].data.memories[0].companion.visibility='public';},
    state=>{state.workspaces[0].data.memories[0].companion.createdAt='yesterday';},
    state=>{state.workspaces[0].data.memories[0].content='x'.repeat(2001);},
    state=>{state.workspaces[0].data.memories[0].companion.history=Array.from({length:51},()=>({...m.companion.history[0]}));},
    state=>{state.workspaces[0].data.memories[0].companion.source.quote='unrelated invented quote';},
    state=>{state.workspaces[0].data.memories[0].companion.source.threadId='normal';},
    state=>{state.workspaces[0].data.threads[0].messages[0].role='assistant';},
  ];
  for(const mutate of invalids){const bad=structuredClone(s);mutate(bad);assert.throws(()=>validateState(bad),error=>error.status===422);}
  data.threads.splice(0,1);assert.equal(validateState(s),s,'source remains identifiable after original self-chat deletion');
  const foreign=emptyState().workspaces[0];foreign.id='foreign';foreign.data.agents.push(agent('agent-a'));foreign.data.threads.push(thread);s.workspaces.push(foreign);
  assert.throws(()=>validateState(s),error=>error.status===422,'source cannot silently resolve into another workspace');
});

test('snapshot validation accepts historic legacy hints and rejects malformed or unrelated snapshots',()=>{
  assert.equal(validKnowledgeHints({skillIds:[],memoryIds:[]}),true);
  const hints={skillIds:[],memoryIds:['m'],memorySnapshots:[{id:'m',content:'茶',agentId:'agent-a',visibility:'private'}]};
  assert.equal(validKnowledgeHints(hints),true);
  for(const mutate of [value=>{value.memoryIds=[];},value=>{value.memorySnapshots[0].visibility='public';},value=>{value.memorySnapshots[0].content='';},value=>{value.memorySnapshots.push({...value.memorySnapshots[0]});},value=>{value.memorySnapshots[0].extra='bad';}]) {
    const bad=structuredClone(hints);mutate(bad);assert.equal(validKnowledgeHints(bad),false);
  }
});
