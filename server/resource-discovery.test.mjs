import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceTools } from './tools.mjs';
const art = (id, kind, title, content, extra={}) => ({id,kind,title,content,threadId:'t',updatedAt:'2026-01-01',...extra});
const table = JSON.stringify({columns:['Name'],rows:[['needle row'],['second']]});
function setup(enabled=['Documents','Tables']) {
 const artifacts = [art('d1','Document','Needle title','first body'),art('d2','Document','second','needle body'),art('table','Table','Budget',table),art('hidden','Document','needle','secret',{archived:true}),art('excluded','Document','needle','secret',{excluded:true}),art('foreign','Document','needle','secret',{workspaceId:'other'}),art('page','Webpage','needle','needle')];
 const state={workspaces:[{id:'w',data:{threads:[{id:'t'}],artifacts}},{id:'other',data:{threads:[{id:'other-t'}],artifacts:[art('outside','Document','needle','secret')]}}]};
 return createWorkspaceTools({state,workspaceId:'w',threadId:'t',enabled,maxCalls:50});
}
test('document search filters kind and authorized workspace; supports bounded pagination',async()=>{
 const r=setup(), a=await r.execute('search_documents',{query:'NEEDLE',limit:1});
 assert.deepEqual(a.results.map(x=>x.id),['d1']); assert.equal(a.next_offset,1); assert.equal(a.truncated,true);
 const b=await r.execute('search_documents',{query:'needle',offset:1}); assert.deepEqual(b.results.map(x=>x.id),['d2']); assert.equal(b.next_offset,null);
 assert.equal(JSON.stringify([a,b]).includes('secret'),false); assert.deepEqual(r.patches(),[]);
});
test('table search matches content but never documents or other workspaces',async()=>{
 const r=setup(); assert.deepEqual((await r.execute('search_tables',{query:'needle'})).results.map(x=>x.id),['table']);
 assert.deepEqual((await r.execute('search_tables',{query:'no match'})).results,[]);
});
test('search and table summary obey independently enabled capabilities',async()=>{
 const docs=setup(['Documents']), tables=setup(['Tables']);
 assert.ok(docs.definitions.some(x=>x.function.name==='search_documents')); assert.ok(!docs.definitions.some(x=>x.function.name==='search_tables'));
 await assert.rejects(docs.execute('search_tables',{query:'x'}),/disabled/); await assert.rejects(tables.execute('search_documents',{query:'x'}),/disabled/);
 const summary=await tables.execute('get_table',{id:'table',mode:'summary'}); assert.deepEqual(summary.columns,['Name']); assert.equal(summary.rowCount,2); assert.equal(Object.hasOwn(summary,'rows'),false);
 assert.deepEqual((await tables.execute('get_table',{id:'table'})).rows,[['needle row'],['second']]);
});
test('search rejects empty and extra arguments and invalid pagination and modes',async()=>{
 for(const [name,args] of [['search_documents',{query:' '}],['search_tables',{query:'x',limit:21}],['search_tables',{query:'x',offset:-1}],['search_tables',{query:'x',workspaceId:'other'}],['get_table',{id:'table',mode:'unknown'}]]) await assert.rejects(setup().execute(name,args),/Invalid/);
});

test('tables reject excluded and non-searchable records',async()=>{
 const artifacts=[art('excluded-table','Table','Hidden',table,{excluded:true}),art('nonsearchable-table','Table','Hidden',table,{isSearchable:false}),art('foreign-table','Table','Hidden',table,{workspaceId:'other'})];
 const state={workspaces:[{id:'w',data:{threads:[{id:'t'}],artifacts}}]};
 const r=createWorkspaceTools({state,workspaceId:'w',threadId:'t',enabled:['Tables']});
 for(const id of ['excluded-table','nonsearchable-table','foreign-table']) await assert.rejects(r.execute('get_table',{id}),/not found/);
 assert.deepEqual(r.patches(),[]);
});
