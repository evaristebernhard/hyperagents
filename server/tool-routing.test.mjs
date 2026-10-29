import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLlm } from './llm.mjs';
const data=()=>({threads:[{id:'t',title:'Routing',messages:[{id:'m',role:'user',text:'Create a local page',context:{settings:{tools:['Webpages'],mode:'Execute'}}}]}],projects:[],skills:[],memories:[],artifacts:[],connections:[]});
const frame=v=>'data: '+JSON.stringify(v)+'\n\n';
const tool=(name,args,id='call_one')=>new Response(frame({choices:[{delta:{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
const answer=()=>new Response(frame({choices:[{delta:{content:'Done'},finish_reason:'stop'}]})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
async function run(fetchImpl,execution={},state={workspaces:[{id:'w',data:data()}]}){
  const llm=createLlm({apiKey:'test-only-not-a-real-key',fetchImpl,load:()=>({state})});
  const req=new EventEmitter(),res=new EventEmitter();res.headersSent=false;res.destroyed=false;let text='';res.writeHead=()=>res.headersSent=true;res.write=s=>{text+=s;return true;};res.end=s=>{text+=s||'';};
  await llm.chat(req,res,{workspaceId:'w',threadId:'t',userMessageId:'m'},execution);
  return text.split('\n\n').filter(Boolean).map(s=>JSON.parse(s.slice(6)));
}
test('real LLM loop routes catalog then artifact to bound adapters and emits staged trace',async()=>{
  let round=0;const requests=[];
  const events=await run(async(_url,opts)=>{const b=JSON.parse(opts.body);requests.push(b);round++;
    if(round===1){assert.ok(b.tools.some(t=>t.function.name==='tool_catalog'));return tool('tool_catalog',{query:'artifact'});}
    if(round===2){const r=JSON.parse(b.messages.at(-1).content);assert.equal(r.scope,'authorized-tools-for-this-run');return tool('create_artifact',{title:'Page',kind:'Webpage',content:'<h1>PRIVATE_INPUT</h1>'},'call_two');}
    return answer();
  });
  assert.equal(round,3);assert.equal(events.filter(e=>e.type==='artifact').length,1);assert.ok(events.some(e=>e.type==='done'));
  const traces=events.filter(e=>e.type==='tool_trace');assert.equal(traces.filter(e=>e.phase==='started').length,2);assert.ok(!JSON.stringify(traces).includes('PRIVATE_INPUT'));
  assert.ok(traces.some(e=>e.name==='create_artifact' && e.source==='workspace' && e.outcome==='prepared' && e.durationMs>=0));
});
test('integration dispatcher preserves pending approval and does not execute a write',async()=>{
  let round=0,executions=0;const approval={id:'approval-1'};
  // Adapter contract here is the existing integration bind result, not an API write.
  const definition={type:'function',function:{name:'prepare_test_write',description:'prepare only',parameters:{type:'object',properties:{},additionalProperties:false}}};
  const state={workspaces:[{id:'w',data:data()}]};
  const llm=createLlm({apiKey:'test-only',load:()=>({state}),integrationRegistry:{bind:()=>({definitions:[definition],execute:async()=>{executions++;return {approval,result:{status:'approval_required'}};}})},fetchImpl:async()=>++round===1?tool('prepare_test_write',{}):answer()});
  const req=new EventEmitter(),res=new EventEmitter();res.destroyed=false;res.headersSent=false;let text='';res.writeHead=()=>res.headersSent=true;res.write=s=>{text+=s;return true;};res.end=s=>text+=s||'';
  await llm.chat(req,res,{workspaceId:'w',threadId:'t',userMessageId:'m'});const events=text.split('\n\n').filter(Boolean).map(s=>JSON.parse(s.slice(6)));
  assert.equal(executions,1);assert.ok(events.some(e=>e.type==='approval'));assert.ok(events.some(e=>e.type==='tool_trace' && e.outcome==='awaiting_approval'));
});
test('Plan mode catalog cannot expose workspace or shell executors',async()=>{
  const state={workspaces:[{id:'w',data:data()}]};state.workspaces[0].data.threads[0].messages[0].context.settings.mode='Plan';
  let called=false;
  const events=await run(async(_u,opts)=>{assert.equal(JSON.parse(opts.body).tools,undefined);return answer();},{shell:{definitions:[{type:'function',function:{name:'shell_execute',description:'shell',parameters:{type:'object'}}}],execute:async()=>called=true}},state);
  assert.equal(called,false);assert.ok(events.some(e=>e.type==='done'));
});
