import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createLlm} from './llm.mjs';
const frame = v => 'data: '+JSON.stringify(v)+'\n\n';
const tool=(name,args,id)=>new Response(frame({choices:[{delta:{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
const answer=()=>new Response(frame({choices:[{delta:{content:'Done'},finish_reason:'stop'}]})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
test('model tool loop discovers and invokes document/table search and table summary',async()=>{
 const artifacts=[{id:'d',kind:'Document',title:'Roadmap',content:'needle document',threadId:'t',updatedAt:'2026-01-01'},{id:'a',kind:'Table',title:'Budget',content:JSON.stringify({columns:['Item'],rows:[['needle table']]}),threadId:'t',updatedAt:'2026-01-01'}];
 const state={workspaces:[{id:'w',data:{threads:[{id:'t',messages:[{id:'m',role:'user',text:'Find resources',context:{settings:{tools:['Documents','Tables'],mode:'Execute'}}}]}],projects:[],skills:[],memories:[],artifacts,connections:[]}}]};
 let round=0;
 const llm=createLlm({apiKey:'synthetic',load:()=>({state}),fetchImpl:async(_url,opts)=>{const body=JSON.parse(opts.body);round++;
  if(round===1){assert.ok(body.tools.some(t=>t.function.name==='search_documents'));assert.ok(body.tools.some(t=>t.function.name==='search_tables'));return tool('search_documents',{query:'needle'},'one');}
  if(round===2){assert.equal(JSON.parse(body.messages.at(-1).content).results[0].id,'d');return tool('search_tables',{query:'needle'},'two');}
  if(round===3){assert.equal(JSON.parse(body.messages.at(-1).content).results[0].id,'a');return tool('get_table',{id:'a',mode:'summary'},'three');}
  const summary=JSON.parse(body.messages.at(-1).content);assert.equal(summary.rowCount,1);assert.equal('rows' in summary,false);return answer();
 }});
 const req=new EventEmitter(),res=new EventEmitter();res.headersSent=false;res.destroyed=false;let text='';res.writeHead=()=>res.headersSent=true;res.write=s=>{text+=s;return true;};res.end=s=>text+=s||'';
 await llm.chat(req,res,{workspaceId:'w',threadId:'t',userMessageId:'m'});
 const events=text.split('\n\n').filter(Boolean).map(s=>JSON.parse(s.slice(6)));assert.equal(round,4,JSON.stringify(events));assert.ok(events.some(e=>e.type==='done'));assert.equal(events.filter(e=>e.type==='tool_trace'&&e.phase==='finished').length,3);
});
