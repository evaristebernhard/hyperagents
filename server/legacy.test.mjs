import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './validation.mjs';
import { prepareLegacy } from './legacy.mjs';

test('legacy preview reconciles missing live links explicitly and does not mutate source or history',()=>{
  const source=emptyState(),d=source.workspaces[0].data;
  d.threads.push({id:'legacy-thread',title:'Keep me',summary:'',time:'',projectId:'missing-project',config:{model:'',provider:'Any',reasoning:'Medium',mode:'Execute',tools:[],agentId:'missing-agent'},messages:[{id:'old-message',role:'user',text:'Keep history',context:{skillIds:['deleted-skill']}}]});
  d.artifacts.push({id:'artifact-1',kind:'Document',title:'Detached',content:'Not discarded',createdAt:'today',updatedAt:'today',threadId:'missing-thread',versions:[]});
  d.agents.push({id:'agent-1',name:'Keep agent',description:'',prompt:'Instructions',skillIds:['missing-skill']});
  d.schedules.push({id:'schedule-1',name:'Keep config',instructions:'Later',cadence:'daily',enabled:true,agentId:'missing-agent'});
  const original=JSON.stringify(source);
  const prepared=prepareLegacy(source,()=>undefined);
  assert.ok(prepared.warnings.length>=5);assert.equal(JSON.stringify(source),original);
  const after=prepared.state.workspaces[0].data;
  assert.equal(after.threads.length,1);assert.equal(after.threads[0].projectId,undefined);assert.equal(after.threads[0].config.agentId,undefined);
  assert.equal(after.threads[0].messages[0].context.skillIds[0],'deleted-skill');
  assert.equal(after.artifacts[0].content,'Not discarded');assert.equal(after.artifacts[0].threadId,undefined);
  assert.deepEqual(after.agents[0].skillIds,[]);assert.equal(after.schedules[0].enabled,false);
});

test('binary attachment migration is blocked before confirmation and never fabricates or removes files',()=>{
  const source=emptyState();source.workspaces[0].data.threads.push({id:'t',title:'Keep binary metadata',summary:'',time:'',messages:[{role:'user',text:'File',context:{attachments:[{id:'file-old',name:'keep.txt',workspaceId:'personal',size:5,mimeType:'text/plain',createdAt:'today'}]}}]});
  const before=JSON.stringify(source);
  assert.throws(()=>prepareLegacy(source,()=>undefined),error=>error.code==='MIGRATION_ATTACHMENTS' && /No attachment was removed/.test(error.message));
  assert.equal(JSON.stringify(source),before);
});
