import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createLlm} from './llm.mjs';
const frame=v=>'data: '+JSON.stringify(v)+'\n\n';
const response=(delta,finish)=>new Response(frame({choices:[{delta,finish_reason:finish}]})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
const tool=(name,args,id)=>response({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
test('keyless public search and genuine follow-ups work through real model routing without Exa credentials',async()=>{
 const state={workspaces:[{id:'w',data:{threads:[{id:'t',messages:[{id:'u',role:'user',text:'Search hello world',context:{settings:{tools:['Search'],mode:'Execute'}}}]}],projects:[],skills:[],memories:[],artifacts:[],connections:[]}}]};
 let turns=0,searches=0;
 const llm=createLlm({apiKey:'synthetic-model-key',load:()=>({state}),publicFetch:async(url,opts)=>{searches++;assert.equal(new URL(url).hostname,'cn.bing.com');assert.equal(opts.redirect,'manual');assert.ok(!JSON.stringify(opts.headers).includes('synthetic-model-key'));return new Response('<rss version="2.0"><channel><item><title>Hello world</title><link>https://example.org/hello</link><description>Historical summary.</description></item></channel></rss>',{headers:{'Content-Type':'text/xml'}});},fetchImpl:async(_url,opts)=>{const body=JSON.parse(opts.body);assert.equal(Object.hasOwn(body,'knowledgeHints'),false);turns++;
 if(turns===1){assert.ok(body.tools.some(d=>d.function.name==='web_search'));assert.ok(!body.tools.some(d=>d.function.name==='exa_search'));return tool('web_search',{query:'hello world'},'call_search');}
 if(turns===2){const result=JSON.parse(body.messages.at(-1).content);assert.equal(result.results[0].title,'Hello world');return tool('suggest_follow_ups',{followUps:['Find the original tutorial','Compare the early examples']},'call_suggestions');}
 return response({content:'The source describes the history.'},'stop');}});
 const req=new EventEmitter(),res=new EventEmitter();res.headersSent=false;res.destroyed=false;let raw='';res.writeHead=()=>res.headersSent=true;res.write=s=>{raw+=s;return true};res.end=s=>raw+=s||'';
 await llm.chat(req,res,{workspaceId:'w',threadId:'t',userMessageId:'u'});
 const events=raw.split('\n\n').filter(Boolean).map(s=>JSON.parse(s.slice(6)));assert.equal(searches,1);assert.equal(turns,3);assert.ok(events.some(e=>e.type==='done'));assert.deepEqual(events.find(e=>e.type==='suggestions').followUps,['Find the original tutorial','Compare the early examples']);
 const preview=events.find(e=>e.type==='tool'&&e.name==='web_search'&&e.status==='success');assert.equal(JSON.parse(preview.summary).results[0].url,'https://example.org/hello');
});
