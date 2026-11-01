import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';

// This focused snapshot omits adapter dependencies. Stub only those adapters;
// exercise the actual LLM loop, registry and validation with synthetic SSE, no network.
const moduleUrl = source => 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const validationSource=(await readFile(new URL('./validation.mjs',import.meta.url),'utf8')).replace("import { parseSlidesContent } from './slides.mjs';",'const parseSlidesContent=JSON.parse;');
const validationUrl=moduleUrl(validationSource);
const {validFollowUps,validReasoningMs,validKnowledgeHints,emptyState,validateState}=await import(validationUrl);
let source=await readFile(new URL('./llm.mjs',import.meta.url),'utf8');
source=source.replace(/^import .* from '\.\/([^']+)';$/gm,(line,name)=>{
  if(name==='validation.mjs')return line.replace('./'+name,validationUrl);
  if(name==='tool-registry.mjs')return line.replace('./'+name,new URL('./'+name,import.meta.url).href);
  if(name==='tool-result-preview.mjs')return 'const summarizeToolResult = result => JSON.stringify(result);';
  if(name==='marketplace.mjs')return 'const requiredSkillTools=()=>[];';
  const symbol=/import \{ (\w+) \}/.exec(line)?.[1];
  assert.ok(symbol, 'known import '+line);
  return `const ${symbol}=()=>({definitions:[],capabilities:[],patches:()=>[],close:async()=>{}});`;
});
const {createLlm,buildConversation}=await import(moduleUrl(source));
const state=()=>({workspaces:[{id:'w',data:{threads:[{id:'t',messages:[{id:'m',role:'user',text:'Help me compare options',context:{settings:{tools:[],mode:'Execute'},skillIds:['s'],memoryIds:['m1']}}]}],agents:[],skills:[{id:'s',name:'Compare',documentation:'Compare honestly.'}],memories:[{id:'m1',content:'Selected'},{id:'m2',pinned:true,content:'Pinned'},{id:'gone',pinned:true,archived:true,content:'Do not include'}],artifacts:[]}}]});
const request={workspaceId:'w',threadId:'t',userMessageId:'m'};
const packet=(delta,finish_reason)=>'data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\n';
const answer=()=>new Response(packet({content:'The comparison is complete.'},'stop')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
const tool=followUps=>new Response(packet({tool_calls:[{index:0,id:'call_suggest',function:{name:'suggest_follow_ups',arguments:JSON.stringify({followUps})}}]},'tool_calls')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
async function run(fetchImpl,execution={},snapshot=state()) {
  const req=new EventEmitter(),res=new EventEmitter(),events=[];
  req.aborted=false;res.destroyed=false;res.headersSent=false;
  res.writeHead=()=>{res.headersSent=true;};
  res.write=s=>{events.push(JSON.parse(s.slice(6)));return true;};
  res.end=s=>{if(s)res.write(s);};
  const llm=createLlm({apiKey:'synthetic-only',load:()=>({state:snapshot}),fetchImpl});
  await llm.chat(req,res,request,execution);return events;
}
test('strict bounded metadata validators and saved assistant payload round-trip',()=>{
  assert.ok(validFollowUps(['Compare costs','Make a shortlist']));
  for(const value of [[],['One'],['same','SAME'],[' A','B'],['A\nB','C'],['x'.repeat(161),'B']])assert.equal(validFollowUps(value),false);
  for(const value of [-1,NaN,Infinity,86400001,1.5,'10'])assert.equal(validReasoningMs(value),false);
  assert.ok(validReasoningMs(0));assert.ok(validKnowledgeHints({skillIds:['s'],memoryIds:[]}));
  assert.equal(validKnowledgeHints({skillIds:['s','s'],memoryIds:[]}),false);
  const saved=emptyState();saved.workspaces[0].data.threads.push({id:'t',title:'Metadata',summary:'',time:'Now',messages:[{role:'assistant',text:'Done',followUps:['Compare costs','Make a shortlist'],reasoningMs:42,knowledgeHints:{skillIds:['historical-skill'],memoryIds:[]}}]});
  assert.doesNotThrow(()=>validateState(JSON.parse(JSON.stringify(saved))));
  saved.workspaces[0].data.threads[0].messages[0].role='user';assert.throws(()=>validateState(saved));
});
test('knowledge hints include actual resolved selections/pinned memories, not archived items',async()=>{
  const conversation=await buildConversation(state(),request);
  assert.deepEqual(conversation.knowledgeHints,{skillIds:['s'],memoryIds:['m1','m2']});
  assert.match(conversation.messages[0].content,/suggest_follow_ups once/);
});
test('model suggestions are optional and only emitted after successful final answer',async()=>{
  const followUps=['Compare total costs','Build a decision matrix'];let calls=0;
  const events=await run(async(_url,opts)=>{
    const body=JSON.parse(opts.body);assert.equal(body.knowledgeHints,undefined);
    assert.ok(body.tools.some(d=>d.function.name==='suggest_follow_ups'));
    return ++calls===1?tool(followUps):answer();
  });
  assert.equal(calls,2);assert.deepEqual(events.find(e=>e.type==='suggestions'),{type:'suggestions',followUps});
  assert.equal(events.at(-1).type,'done');
  const plain=await run(async()=>answer());assert.equal(plain.some(e=>e.type==='suggestions'),false);
});
test('invalid suggestions and repeated calls cannot manufacture or overwrite suggestions',async()=>{
  let count=0;const invalid=await run(async()=>++count===1?tool(['Only one']):answer());
  assert.equal(invalid.some(e=>e.type==='suggestions'),false);
  assert.ok(invalid.some(e=>e.type==='tool'&&e.status==='error'));
  count=0;const first=['Compare costs','Make a shortlist'];
  const repeated=await run(async()=>++count===1?tool(first):count===2?tool(['Other one','Other two']):answer());
  assert.deepEqual(repeated.find(e=>e.type==='suggestions').followUps,first);
  assert.ok(repeated.some(e=>e.type==='tool'&&e.status==='error'));
});
test('failure after suggestion tool suppresses suggestions and done',async()=>{
  let count=0;const events=await run(async()=>{if(++count===1)return tool(['Compare costs','Make a shortlist']);throw Error('synthetic failure');});
  assert.equal(events.some(e=>e.type==='suggestions'||e.type==='done'),false);
  assert.equal(events.at(-1).type,'error');
});
test('reasoning timing uses observed wall time and adds no raw-reasoning metadata',async()=>{
  const events=await run(async()=>{
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({async start(controller){
      controller.enqueue(encoder.encode(packet({reasoning_content:'PRIVATE_REASONING'})));
      await new Promise(resolve=>setTimeout(resolve,25));
      controller.enqueue(encoder.encode(packet({content:'Done'},'stop')+'data: [DONE]\n\n'));controller.close();
    }}),{headers:{'Content-Type':'text/event-stream'}});
  });
  const timing=events.filter(e=>e.type==='reasoning_timing');assert.ok(timing.length>=1);
  assert.ok(timing.at(-1).reasoningMs>=15);assert.ok(validReasoningMs(timing.at(-1).reasoningMs));
  assert.deepEqual(Object.keys(timing.at(-1)).sort(),['reasoningMs','type']);
  assert.equal(JSON.stringify(events.filter(e=>e.type!=='reasoning')).includes('PRIVATE_REASONING'),false);
});
test('Plan and read-only retain only display-only metadata capability',async()=>{
  for(const mode of ['Plan','Execute']){
    const snapshot=state();snapshot.workspaces[0].data.threads[0].messages[0].context.settings.mode=mode;
    const events=await run(async(_url,opts)=>{assert.deepEqual(JSON.parse(opts.body).tools.map(d=>d.function.name),['suggest_follow_ups']);return answer();},{readOnly:true},snapshot);
    assert.ok(events.some(e=>e.type==='done'));
  }
});

test('real run manager persists validated metadata only on success without schema changes',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
  let managerSource=await readFile(new URL('./agent-runs.mjs',import.meta.url),'utf8');
  managerSource=managerSource.replace(/^import .* from '\.\/([^']+)';$/gm,(line,name)=>{
    if(name==='validation.mjs')return line.replace('./'+name,validationUrl);
    if(name==='llm.mjs')return line.replace('./'+name,moduleUrl(source));
    if(name==='managed-actions.mjs')return 'const normalizeManagedAction=x=>x,managedActionSucceeded=()=>true;';
    if(name==='managed-skills.mjs')return 'const createManagedSkillTools=()=>({definitions:[]});';
    if(name==='workspace-file-tools.mjs')return 'const createWorkspaceFileTools=()=>({definitions:[]});';
    if(name==='shell-runtime.mjs')return 'const createShellRuntime=()=>({});';
    throw Error('Unexpected import '+name);
  });
  const {createRunManager}=await import(moduleUrl(managerSource));
  for(const successful of [true,false]){
    const directory=await mkdtemp(path.join(tmpdir(),'thread-metadata-'));
    let resolveSaved;const saved=new Promise(resolve=>{resolveSaved=resolve;});
    const snapshot=state(),hints={skillIds:['s'],memoryIds:['m1','m2']};
    const manager=createRunManager({dataDir:directory,load:()=>({state:snapshot}),persist:run=>{resolveSaved(run);return true;},llm:{config:()=>({configured:true}),chat:async(_req,res)=>{
      for(const event of [{type:'delta',text:'Answer'},{type:'suggestions',followUps:['Compare costs','Make a shortlist']},{type:'reasoning_timing',reasoningMs:28},{type:'knowledge_hints',knowledgeHints:hints},successful?{type:'done',model:'deepseek-flash'}:{type:'error',message:'Synthetic failure'}])res.write('data: '+JSON.stringify(event)+'\n\n');res.end();
    }}});
    try{
      const admitted=await manager.create(request);const result=await saved;
      assert.equal(result.status,successful?'succeeded':'failed');
      if(successful){assert.deepEqual(result.followUps,['Compare costs','Make a shortlist']);assert.equal(result.reasoningMs,28);assert.deepEqual(result.knowledgeHints,hints);}
      else for(const key of ['followUps','reasoningMs','knowledgeHints'])assert.equal(Object.hasOwn(result,key),false);
      const replay=manager.events(admitted.id,request);assert.ok(replay.events.some(e=>e.event.type==='reasoning_timing'));
    }finally{await manager.close();await rm(directory,{recursive:true,force:true});}
  }
});
