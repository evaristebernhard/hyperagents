import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createRunManager} from './agent-runs.mjs';
import {emptyState} from './validation.mjs';
const request={workspaceId:'personal',threadId:'root',userMessageId:'brief'};
const finish=(res,text)=>{res.write(`data: ${JSON.stringify({type:'delta',text})}\n\n`);res.write(`data: ${JSON.stringify({type:'done',model:'deepseek-flash'})}\n\n`);res.end();};
async function until(fn){for(let i=0;i<300;i++){const value=fn();if(value)return value;await delay(5);}throw Error('Test wait timed out');}
async function fixture(t,model,{tools=['Delegation','Thread Search','Shell','Skills','Files','Documents','Artifacts','GitHub'],host}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'delegation-runtime-'));await mkdir(path.join(dir,'shell'));
  const state=emptyState(),data=state.workspaces[0].data;
  data.agents.push({id:'reader',name:'Real Reader',description:'Reads saved threads',prompt:'Answer the supplied brief',tools:['Thread Search','Shell','Skills','Files','Delegation','Artifacts','Documents','GitHub']},{id:'archived',name:'Archived',archived:true,tools:[]});
  data.threads.push({id:'root',config:{tools},messages:[{id:'brief',role:'user',text:'Parent private history must not be copied'}]});
  const calls=[],saved=[],hosts=[];let manager;
  const llm={config:()=>({configured:true}),chat:async(req,res,body,execution)=>{calls.push({body,execution,req});assert.deepEqual(Object.keys(body).sort(),['threadId','userMessageId','workspaceId']);return model({req,res,body,execution,manager,data});}};
  const createDelegatedThread=async input=>{
    hosts.push(input);if(host)return host(input);
    const id='child-'+createHash('sha256').update(JSON.stringify([input.parentRunId,input.agentId,input.task])).digest('hex').slice(0,16);
    if(!data.threads.some(t=>t.id===id))data.threads.push({id,config:{agentId:input.agentId,tools:input.tools},messages:[{id:'task',role:'user',text:input.task}]});
    return {workspaceId:input.workspaceId,threadId:id,userMessageId:'task'};
  };
  manager=createRunManager({dataDir:dir,shellRoot:path.join(dir,'shell'),llm,load:()=>({state}),readAttachment:async()=>null,persist:value=>{saved.push(value);return true;},createDelegatedThread,maxConcurrent:1});
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  return {manager,state,data,calls,saved,hosts};
}
const names=e=>e.tools.definitions.map(d=>d.function.name);
const tool=(e,name,args={})=>e.tools.execute(name,args);

test('real isolated child executes while root waits; permission intersection, scoped result and retries', {timeout:5000},async t=>{
  let childRun,rootFinished=false;
  const h=await fixture(t,async({res,body,execution,data})=>{
    if(body.threadId==='root'){
      assert.ok(names(execution).includes('delegate_agent'));
      const listed=await tool(execution,'list_agents');assert.deepEqual(listed.agents.map(a=>a.id),['reader']);assert.deepEqual(listed.agents[0].tools,['Thread Search','Documents']);
      const args={agentId:'reader',task:'Independently answer the read-only brief'};
      const [a,b]=await Promise.all([tool(execution,'delegate_agent',args),tool(execution,'delegate_agent',args)]);
      assert.equal(a.runId,b.runId);childRun=a.runId;
      const result=await tool(execution,'wait_for_delegated_run',{runId:a.runId,timeoutSeconds:2});
      assert.equal(result.status,'succeeded');assert.equal(result.text,'Genuine child model answer');assert.equal(result.resultSaved,true);
      assert.equal((await tool(execution,'delegate_agent',args)).runId,a.runId);
      finish(res,'Parent synthesis');rootFinished=true;
    }else{
      assert.equal(execution.readOnly,true);assert.deepEqual(execution.allowedTools,['Thread Search','Documents']);assert.equal(execution.shell,undefined);
      assert.ok(!names(execution).includes('delegate_agent'));assert.equal(execution.maxConcurrent,3);
      await assert.rejects(()=>tool(execution,'delegate_agent',{agentId:'reader',task:'Recurse'}),/not enabled/);
      const thread=data.threads.find(t=>t.id===body.threadId);assert.equal(thread.messages.length,1);assert.equal(thread.messages[0].text,'Independently answer the read-only brief');
      finish(res,'Genuine child model answer');
    }
  });
  const root=await h.manager.create(request);await until(()=>rootFinished);await until(()=>h.manager.get(root.id).status==='succeeded');
  assert.equal(h.calls.length,2);assert.equal(h.hosts.length,1);assert.equal(h.manager.get(childRun).parentRunId,root.id);
  assert.deepEqual(h.hosts[0].tools,['Thread Search','Documents']);assert.equal(h.saved.length,2);assert.equal(h.manager.get(root.id).childCount,1);
});

test('only saved Delegation enables dispatch; public private-metadata and parentRunId spoofing are rejected', {timeout:5000},async t=>{
  const h=await fixture(t,async({execution,res})=>{
    assert.ok(!names(execution).includes('list_agents'));
    await assert.rejects(()=>tool(execution,'delegate_agent',{agentId:'reader',task:'Unauthorized'}),/not enabled/);finish(res,'No delegation');
  },{tools:['Thread Search']});
  for(const extra of [{_delegation:{allowedTools:['Shell']}},{_runTools:['Delegation']},{parentRunId:'spoof'},{readOnly:false},{allowedTools:['Shell']}])await assert.rejects(()=>h.manager.create({...request,...extra}),/Invalid run request/);
  const run=await h.manager.create(request);await until(()=>h.manager.get(run.id).status==='succeeded');assert.equal(h.hosts.length,0);
});

test('get/wait reject non-child or foreign workspace runs, malformed arguments and archived agents', {timeout:5000},async t=>{
  let checked=false;
  const h=await fixture(t,async({execution,res,manager,body})=>{
    if(body.threadId!=='root'){finish(res,'Unrelated root');return;}
    const unrelated=await manager.create({workspaceId:'foreign',threadId:'elsewhere',userMessageId:'brief'});
    for(const name of ['get_delegated_run','wait_for_delegated_run'])await assert.rejects(()=>tool(execution,name,{runId:unrelated.id}),/Direct delegated run not found/);
    await assert.rejects(()=>tool(execution,'delegate_agent',{agentId:'archived',task:'No'}),/not available/);
    await assert.rejects(()=>tool(execution,'delegate_agent',{agentId:'reader',task:'Yes',tools:['Shell']}),/Invalid delegation arguments/);
    await assert.rejects(()=>tool(execution,'list_agents',{workspaceId:'foreign'}),/Invalid delegation arguments/);
    checked=true;finish(res,'Scope protected');
  });
  const foreign=emptyState().workspaces[0];foreign.id='foreign';foreign.data.threads.push({id:'elsewhere',messages:[{id:'brief',role:'user',text:'Other workspace'}]});
  h.state.workspaces.push(foreign);
  const root=await h.manager.create(request);await until(()=>checked);await until(()=>h.manager.get(root.id).status==='succeeded');assert.equal(h.hosts.length,0);
});

test('parent cancellation aborts a running child and cancels queued children without queue deadlock', {timeout:5000},async t=>{
  let rootId,ready=false;const children=[];
  const h=await fixture(t,async({req,res,body,execution})=>{
    if(body.threadId==='root'){
      for(let i=0;i<3;i++)children.push(await tool(execution,'delegate_agent',{agentId:'reader',task:'Hold '+i}));
      ready=true;await new Promise(resolve=>req.once('aborted',resolve));
    }else await new Promise(resolve=>req.once('aborted',resolve));
  });
  rootId=(await h.manager.create(request)).id;await until(()=>ready);
  assert.equal(h.calls.length,3,'one root plus two child slots');assert.equal(h.manager.get(children[2].runId).status,'queued');
  h.manager.cancel(rootId,request);
  await until(()=>children.every(c=>h.manager.get(c.runId).status==='cancelled'));
  await until(()=>h.manager.get(rootId).status==='cancelled');assert.equal(h.calls.length,3);
});

test('host failure and child admission failure never return a successful delegation', {timeout:5000},async t=>{
  let checked=false;
  const h=await fixture(t,async({execution,res})=>{
    await assert.rejects(()=>tool(execution,'delegate_agent',{agentId:'reader',task:'Fail host'}),/could not be saved/);checked=true;finish(res,'Host failed');
  },{host:()=>{throw Error('synthetic private host details');}});
  const run=await h.manager.create(request);await until(()=>checked);await until(()=>h.manager.get(run.id).status==='succeeded');assert.equal(h.manager.get(run.id).childCount,0);assert.equal(h.calls.length,1);
  let rejected=false;
  const invalid=await fixture(t,async({execution,res})=>{
    await assert.rejects(()=>tool(execution,'delegate_agent',{agentId:'reader',task:'Invalid child admission'}),/invalid child thread/);
    rejected=true;finish(res,'Admission failed');
  },{host:()=>({workspaceId:'foreign',threadId:'forged',userMessageId:'brief'})});
  const next=await invalid.manager.create(request);await until(()=>rejected);await until(()=>invalid.manager.get(next.id).status==='succeeded');
  assert.equal(invalid.manager.get(next.id).childCount,0);assert.equal(invalid.calls.length,1);
});

test('eight-child budget and bounded waits/results are enforced', {timeout:5000},async t=>{
  let checked=false;
  const h=await fixture(t,async({execution,res,body})=>{
    if(body.threadId!=='root'){finish(res,'x'.repeat(14000));return;}
    for(let i=0;i<8;i++){
      const c=await tool(execution,'delegate_agent',{agentId:'reader',task:'Task '+i});
      await assert.rejects(()=>tool(execution,'wait_for_delegated_run',{runId:c.runId,timeoutSeconds:31}),/between 0 and 30/);
      const result=await tool(execution,'wait_for_delegated_run',{runId:c.runId,timeoutSeconds:1});assert.equal(result.text.length,12000);assert.equal(result.truncated,true);
    }
    await assert.rejects(()=>tool(execution,'delegate_agent',{agentId:'reader',task:'Ninth'}),/budget exhausted/);checked=true;finish(res,'Eight done');
  });
  const root=await h.manager.create(request);await until(()=>checked);await until(()=>h.manager.get(root.id).status==='succeeded');assert.equal(h.hosts.length,8);assert.equal(h.calls.length,9);
});

test('delegation tool listing reflects parent and target capability intersection', {timeout:5000},async t=>{
  let checked=false;
  const h=await fixture(t,async({execution,res,body})=>{
    if(body.threadId==='root'){
      const listed=await tool(execution,'list_agents');
      assert.deepEqual(listed.agents[0].tools,['Documents']);
      const child=await tool(execution,'delegate_agent',{agentId:'reader',task:'Read an allowed document'});
      const result=await tool(execution,'wait_for_delegated_run',{runId:child.runId,timeoutSeconds:2});
      assert.equal(result.status,'succeeded');checked=true;finish(res,'Done');
    }else{
      assert.equal(execution.readOnly,true);assert.deepEqual(execution.allowedTools,['Documents']);
      finish(res,'Only document permission inherited');
    }
  },{tools:['Delegation','Documents','Tables']});
  const run=await h.manager.create(request);await until(()=>checked);await until(()=>h.manager.get(run.id).status==='succeeded');
  assert.deepEqual(h.hosts[0].tools,['Documents']);
});
