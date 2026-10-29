import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
let revision=0;
async function load(api){
  class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
  globalThis.__runClientMock={api,ApiError};
  const source=(await readFile(new URL('../src/run-client.ts',import.meta.url),'utf8')).replace('import { api, ApiError } from "./backend-client";','const {api,ApiError}=globalThis.__runClientMock;');
  const code=stripTypeScriptTypes(source,{mode:'strip'})+'\n// revision '+(++revision);
  return {client:await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')),ApiError};
}
const scope={workspaceId:'personal',threadId:'t1'};
const run={id:'run1',...scope,userMessageId:'u1',status:'running',createdAt:'2026-10-29T00:00:00Z',toolCount:0,approvals:[]};
test('durable viewer replays ordered cursors, ignores duplicates and finishes without re-executing',async()=>{
  const paths=[],received=[],cursors=[];
  const {client}=await load(async path=>{paths.push(path);return paths.length===1?{run,events:[{seq:1,event:{type:'delta',text:'one'}},{seq:2,event:{type:'delta',text:'two'}}],nextCursor:2,hasMore:true}:{run:{...run,status:'succeeded',resultSaved:true},events:[{seq:2,event:{type:'delta',text:'duplicate'}},{seq:3,event:{type:'done',model:'deepseek-flash'}}],nextCursor:3,hasMore:false};});
  const result=await client.followRun({id:'run1',scope,signal:new AbortController().signal,onEvent:e=>received.push(e),onCursor:n=>cursors.push(n),onRun:()=>{},onConnection:()=>{}});
  assert.equal(result.status,'succeeded');assert.deepEqual(received.map(e=>e.text||e.type),['one','two','done']);assert.ok(paths[1].endsWith('after=2'));assert.equal(cursors.at(-1),3);assert.ok(paths.every(p=>p.includes('/events?')));
});
test('detaching a viewer never calls the server cancellation endpoint',async()=>{
  const paths=[],controller=new AbortController();
  const {client}=await load(async path=>{paths.push(path);controller.abort();return {run,events:[],nextCursor:0,hasMore:false};});
  await assert.rejects(client.followRun({id:'run1',scope,signal:controller.signal,onEvent:()=>{},onCursor:()=>{},onRun:()=>{},onConnection:()=>{}}),e=>e.name==='AbortError');
  assert.equal(paths.length,1);assert.ok(!paths.some(p=>p.includes('cancel')));
});
test('authorization errors pause viewing immediately and shell approvals require an explicit scoped decision',async()=>{
  let ApiError,calls=0,recorded;
  const loaded=await load(async (path,options)=>{calls++;if(path.includes('/events?'))throw new ApiError('Sign in required',401);recorded={path,options};return {run};});ApiError=loaded.ApiError;
  await assert.rejects(loaded.client.followRun({id:'run1',scope,signal:new AbortController().signal,onEvent:()=>{},onCursor:()=>{},onRun:()=>{},onConnection:()=>{}}),/Viewing paused/);assert.equal(calls,1);
  await loaded.client.decideShellApproval('run1','action1',scope,'deny');assert.equal(recorded.options.method,'POST');assert.deepEqual(recorded.options.body,{...scope,decision:'deny'});assert.match(recorded.path,/approvals\/action1$/);
});
