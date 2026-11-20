import { planDefinition, validateManagedPlan } from './managed-plan.mjs';
import { normalizeManagedAction, managedActionSucceeded } from './managed-actions.mjs';
import { createManagedSkillTools } from './managed-skills.mjs';
import { createWorkspaceFileTools } from './workspace-file-tools.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {lstatSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {ApiError,validFollowUps,validReasoningMs,validKnowledgeHints} from './validation.mjs';
import {buildConversation,MODELS} from './llm.mjs';
import {createShellRuntime} from './shell-runtime.mjs';

const terminal=new Set(['succeeded','failed','cancelled','interrupted']);
const MAX_CHILDREN=8, MAX_DEPTH=3, MAX_TREE=32, CHILD_SLOTS=2;
// Explicit capability allowlist: no skills, files, browser sessions, artifacts,
// integrations or generic execution. The LLM boundary must also filter definitions.
const READ_ONLY_TOOLS=new Set(['Thread Search','Search','Find Similar','Documents','Tables']);
const delegatedTools=(agent,parentTools)=>[...new Set((agent.tools||[]).filter(t=>READ_ONLY_TOOLS.has(t)&&parentTools.includes(t)))];
const chatRequest=request=>Object.fromEntries(['workspaceId','threadId','userMessageId','model'].filter(k=>request[k]!==undefined).map(k=>[k,request[k]]));
const managedDefinition=(name,description,properties,required=[])=>({type:'function',function:{name,description,parameters:{type:'object',additionalProperties:false,properties,required}}});
const runIdSchema={type:'string',minLength:1,maxLength:200};
function delegationDefinitions(agents){
  // Advertise only actual identities in this run's workspace snapshot. The
  // executor still checks the current workspace and permissions at dispatch;
  // an enum is model guidance/schema validation, never an authorization grant.
  const agentIds=[...new Set(agents.filter(agent=>!agent.archived).map(agent=>agent.id))];
  return [
    managedDefinition('list_agents','List real, available agents in this workspace. No agent is created.',{}),
    ...(agentIds.length?[managedDefinition('delegate_agent','Start one real read-only child agent using an exact saved agent ID returned by list_agents. Include a self-contained task. Retrying the same agent and exact task reuses its run.',{agentId:{...runIdSchema,enum:agentIds},task:{type:'string',minLength:1,maxLength:16000}},['agentId','task'])]:[]),
    managedDefinition('get_delegated_run','Read bounded real output and status of a direct child run.',{runId:runIdSchema},['runId']),
    managedDefinition('wait_for_delegated_run','Wait once, at most 30 seconds, for a direct child. Returns current status on timeout.',{runId:runIdSchema,timeoutSeconds:{type:'number',minimum:0,maximum:30}},['runId'])
  ];
}
const active=new Set(['queued','running','waiting_approval']);
const stamp=()=>new Date().toISOString();
const fail=(status,message)=>{throw new ApiError(status,message,'AGENT_RUN');};
const digest=text=>createHash('sha256').update(text).digest('hex');
const definition={type:'function',function:{name:'shell_execute',description:'Propose one exact local shell command and wait for explicit human approval. No command runs before approval. Full local user authority, not a sandbox. Never include credentials or start detached/background processes.',parameters:{type:'object',additionalProperties:false,required:['command'],properties:{command:{type:'string',description:'Exact bash command visible to the user; maximum 8192 characters.'},cwd:{type:'string',description:'Directory within the configured project root. Default is the project root.'},timeoutSeconds:{type:'integer',minimum:1,maximum:300,description:'Bounded command deadline, default 30 seconds.'}}}}};



/** Durable event log and managed runs. Disconnecting a viewer never cancels a run.
 * On process restart active rows are interrupted, never automatically replayed.
 * Shell execution is local on this WSL host; no gateway credentials are copied. */
export function createRunManager({dataDir,llm,load,persist,readAttachment,validateAdmission,createDelegatedThread,createContinuationMessage,skillCatalog=[],skillRoot,skillCredentialProvider,persistGeneratedFile,shellRoot,maxConcurrent=2,timeoutMs=20*60*1000}) {
  const file=path.join(dataDir,'agent-runs.sqlite');
  try {if(lstatSync(file).isSymbolicLink())throw Error('Run database cannot be a symbolic link.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(file);chmodSync(file,0o600);
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version!==0 && version!==1){db.close();throw Error('Unsupported run database version.');}
  if(version===0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length){db.close();throw Error('Unrecognized run database.');}
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, source_hash TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, started TEXT, finished TEXT, model TEXT, error TEXT, tool_count INTEGER NOT NULL DEFAULT 0, usage TEXT, plan TEXT, result_saved INTEGER NOT NULL DEFAULT 0, parent_run_id TEXT REFERENCES agent_runs(id), root_run_id TEXT, depth INTEGER NOT NULL DEFAULT 0, child_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS runs_thread ON agent_runs(workspace_id,thread_id,created);
    CREATE TABLE IF NOT EXISTS run_events (run_id TEXT NOT NULL REFERENCES agent_runs(id), seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(run_id,seq));
    CREATE TABLE IF NOT EXISTS shell_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id), args TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL);
    PRAGMA user_version=1;`);
  for (const [name, ddl] of [['parent_run_id','ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT REFERENCES agent_runs(id)'],['root_run_id','ALTER TABLE agent_runs ADD COLUMN root_run_id TEXT'],['depth','ALTER TABLE agent_runs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0'],['child_count','ALTER TABLE agent_runs ADD COLUMN child_count INTEGER NOT NULL DEFAULT 0']]) { if(!db.prepare('PRAGMA table_info(agent_runs)').all().some(c=>c.name===name)) db.exec(ddl); }
  db.exec('CREATE INDEX IF NOT EXISTS runs_parent ON agent_runs(parent_run_id,created);');
  if(!db.prepare('PRAGMA table_info(agent_runs)').all().some(c=>c.name==='plan'))db.exec('ALTER TABLE agent_runs ADD COLUMN plan TEXT');
  const raw=id=>db.prepare('SELECT * FROM agent_runs WHERE id=?').get(id);
  const controls=new Map(),eventBudgets=new Map(),delegating=new Map(),continuing=new Map(),changes=new EventEmitter();changes.setMaxListeners(0);let closed=false,pumping=false;
  const shell=createShellRuntime({root:shellRoot,maxConcurrent});
  function append(id,event){
    const row=eventBudgets.get(id) || db.prepare('SELECT COALESCE(MAX(seq),0) AS seq, COALESCE(SUM(length(event)),0) AS bytes FROM run_events WHERE run_id=?').get(id); eventBudgets.set(id,row);
    const text=JSON.stringify(event);
    if(row.seq>=50000 || row.bytes+text.length>8*1024*1024)throw Error('Run event budget exhausted');
    db.prepare('INSERT INTO run_events VALUES (?,?,?)').run(id,row.seq+1,text);row.seq++;row.bytes+=text.length;changes.emit(id);
  }
  const old=db.prepare("SELECT id FROM agent_runs WHERE status IN ('queued','running','waiting_approval')").all();
  for(const {id} of old){db.prepare("UPDATE agent_runs SET status='interrupted',finished=?,error=? WHERE id=?").run(stamp(),'The server restarted. No commands were replayed. Review results before starting a new request.',id);db.prepare("UPDATE shell_actions SET status='expired' WHERE run_id=? AND status IN ('pending','approved','executing')").run(id);append(id,{type:'run_status',status:'interrupted'});}
  function scope(row,request={}){
    if(!row)fail(404,'Run not found.');
    if((request.workspaceId!==undefined && row.workspace_id!==request.workspaceId)||(request.threadId!==undefined && row.thread_id!==request.threadId))fail(404,'Run not found in this workspace/thread.');
    const w=load().state.workspaces.find(w=>w.id===row.workspace_id),t=w?.data.threads.find(t=>t.id===row.thread_id&&!t.archived);
    if(!t)fail(404,'Run thread is unavailable.');return t;
  }
  function info(row){const continuedFromRunId=JSON.parse(row.request)._continuation?.sourceRunId;return {id:row.id,workspaceId:row.workspace_id,threadId:row.thread_id,userMessageId:row.message_id,status:row.status,createdAt:row.created,...(continuedFromRunId?{continuedFromRunId}:{}),...(row.started?{startedAt:row.started}:{}),...(row.finished?{finishedAt:row.finished}:{}),...(row.model?{model:row.model}:{}),...(row.error?{error:row.error}:{}),toolCount:row.tool_count,...(row.usage?{usage:JSON.parse(row.usage)}:{}),resultSaved:!!row.result_saved,...(row.plan?{plan:JSON.parse(row.plan)}:{}),...(row.parent_run_id?{parentRunId:row.parent_run_id}:{}),...(row.root_run_id?{rootRunId:row.root_run_id}:{}),depth:row.depth ?? 0,childCount:row.child_count ?? 0,approvals:db.prepare('SELECT id,args,status FROM shell_actions WHERE run_id=? ORDER BY created').all(row.id).map(a=>({id:a.id,status:a.status,...JSON.parse(a.args)}))};}
  function setStatus(id,status){db.prepare('UPDATE agent_runs SET status=? WHERE id=?').run(status,id);append(id,{type:'run_status',status});}
  async function propose(id,args,signal,executeAction){
    scope(raw(id));const normalized=executeAction?normalizeManagedAction(args):shell.normalize(args),actionId=randomUUID();
    db.prepare('INSERT INTO shell_actions VALUES (?,?,?,?,?)').run(actionId,id,JSON.stringify(normalized),'pending',stamp());
    setStatus(id,'waiting_approval');append(id,{type:'shell_approval',actionId,...normalized});
    let approved;
    try {
      approved=await new Promise((resolve,reject)=>{
        const ctl=controls.get(id);if(!ctl || signal.aborted)return reject(Error('Run cancelled'));
        let timer;
        const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);ctl.decision=undefined;};
        const abort=()=>{cleanup();db.prepare("UPDATE shell_actions SET status='cancelled' WHERE id=? AND status='pending'").run(actionId);reject(Error('Run cancelled'));};
        ctl.decision={actionId,resolve:value=>{cleanup();resolve(value);}};
        timer=setTimeout(()=>{cleanup();db.prepare("UPDATE shell_actions SET status='expired' WHERE id=? AND status='pending'").run(actionId);resolve(false);},10*60*1000);timer.unref();
        signal.addEventListener('abort',abort,{once:true});
      });
      if(signal.aborted)throw Error('Run cancelled');
      scope(raw(id));setStatus(id,'running');
      if(!approved)return {status:'denied',executed:false,message:'The user did not approve this exact command. Do not execute or circumvent the decision.'};
      db.prepare("UPDATE shell_actions SET status='executing' WHERE id=?").run(actionId);
      const result=executeAction?await executeAction(signal):await shell.execute(normalized,{signal});
      db.prepare('UPDATE shell_actions SET status=? WHERE id=?').run(result.cancelled||result.status==='cancelled'?'cancelled':managedActionSucceeded(result)?'completed':'failed',actionId);
      append(id,{type:'shell_result',actionId,result});return {status:'executed',...result};
    } catch(e){db.prepare("UPDATE shell_actions SET status='failed' WHERE id=? AND status IN ('pending','approved','executing')").run(actionId);throw e;}
  }
  function parentActive(id){
    const row=raw(id);scope(row);
    if(!active.has(row.status)||controls.get(id)?.controller.signal.aborted||closed)fail(409,'Parent run is no longer active.');
    return row;
  }
  function budget(parent){
    if(parent.depth>=MAX_DEPTH||parent.child_count>=MAX_CHILDREN)fail(429,'Parent child/depth budget exhausted.');
    if(db.prepare('SELECT count(*) AS n FROM agent_runs WHERE id=? OR root_run_id=?').get(parent.root_run_id||parent.id,parent.root_run_id||parent.id).n>=MAX_TREE)fail(429,'Run tree budget exhausted.');
  }
  function authorizedParent(id){
    const parent=parentActive(id),saved=JSON.parse(parent.request);
    if(parent.parent_run_id||saved._delegation||!saved._runTools?.includes('Delegation'))fail(403,'Delegation is not enabled for this run.');
    return parent;
  }
  function childResult(parentId,id){
    const parent=raw(parentId),child=raw(id);scope(parent);
    if(!child||child.parent_run_id!==parent.id||child.workspace_id!==parent.workspace_id)fail(404,'Direct delegated run not found.');
    scope(child,{workspaceId:parent.workspace_id});
    // Project delta text only; never expose requests, contexts, approvals or credentials.
    let text='',truncated=false;
    for(const row of db.prepare('SELECT event FROM run_events WHERE run_id=? ORDER BY seq').iterate(id)){
      const e=JSON.parse(row.event);if(e.type!=='delta'||typeof e.text!=='string')continue;
      if(text.length+e.text.length>12000){text+=e.text.slice(0,12000-text.length);truncated=true;break;}text+=e.text;
    }
    return {runId:child.id,threadId:child.thread_id,status:child.status,resultSaved:!!child.result_saved,text,truncated,...(child.error?{error:child.error}: {})};
  }
  async function delegate(parentId,args){
    let parent=authorizedParent(parentId);
    if(typeof createDelegatedThread!=='function')fail(503,'Delegated thread host is not configured.');
    const agent=load().state.workspaces.find(w=>w.id===parent.workspace_id)?.data.agents.find(a=>a.id===args.agentId&&!a.archived);
    if(!agent)fail(404,'Agent is not available in this workspace.');
    const key=digest(JSON.stringify([parentId,args.agentId,args.task]));
    const existing=()=>db.prepare('SELECT * FROM agent_runs WHERE parent_run_id=?').all(parentId).find(r=>JSON.parse(r.request)._delegation?.key===key);
    const old=existing();if(old)return childResult(parentId,old.id);
    if(delegating.has(key))return delegating.get(key);
    const work=(async()=>{
      budget(parent);
      const parentTools=JSON.parse(parent.request)._runTools;
      const tools=delegatedTools(agent,parentTools);
      let child;
      try{child=await createDelegatedThread({workspaceId:parent.workspace_id,parentThreadId:parent.thread_id,parentRunId:parent.id,agentId:agent.id,task:args.task,tools:[...tools]});}
      catch{fail(503,'Delegated thread could not be saved. No child run was admitted.');}
      parent=authorizedParent(parentId);budget(parent);
      const currentAgent=load().state.workspaces.find(w=>w.id===parent.workspace_id)?.data.agents.find(a=>a.id===agent.id&&!a.archived);
      if(!currentAgent||tools.some(t=>!currentAgent.tools?.includes(t)))fail(409,'Agent permissions changed during delegated admission.');
      if(!child||child.workspaceId!==parent.workspace_id||child.threadId===parent.thread_id)fail(409,'Delegated host returned an invalid child thread.');
      const thread=scope({workspace_id:child.workspaceId,thread_id:child.threadId});
      const message=thread.messages?.[0],settings=message?.context?.settings||thread.config;
      if(thread.messages?.length!==1||message.id!==child.userMessageId||message.role!=='user'||message.text!==args.task||
        settings?.agentId!==agent.id||!Array.isArray(settings.tools)||settings.tools.length!==tools.length||tools.some(t=>!settings.tools.includes(t))||
        (message.context&&Object.keys(message.context).some(k=>k!=='settings'))||thread.projectId||thread.project)
        fail(409,'Delegated host must save an isolated task and exact read-only settings.');
      const run=await admit(chatRequest(child),{parentId,key,agentId:agent.id,allowedTools:tools});
      return childResult(parentId,run.id);
    })();
    delegating.set(key,work);
    try{return await work;}finally{delegating.delete(key);}
  }
  async function delegationTool(parentId,name,args,signal){
    const parent=authorizedParent(parentId);
    const allowed={list_agents:[],delegate_agent:['agentId','task'],get_delegated_run:['runId'],wait_for_delegated_run:['runId','timeoutSeconds']}[name];
    if(!allowed||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k)))fail(400,'Invalid delegation arguments.');
    if(name==='list_agents')return {agents:load().state.workspaces.find(w=>w.id===raw(parentId).workspace_id).data.agents.filter(a=>!a.archived).map(a=>({id:a.id,name:a.name,description:a.description,model:a.model,tools:delegatedTools(a,JSON.parse(parent.request)._runTools)}))};
    if(name==='delegate_agent'){
      if(typeof args.agentId!=='string'||args.agentId.length>200||!args.agentId||typeof args.task!=='string'||!args.task.trim()||args.task.length>16000)fail(400,'Invalid agent or self-contained task.');
      return delegate(parentId,args);
    }
    if(typeof args.runId!=='string'||!args.runId||args.runId.length>200)fail(400,'Invalid delegated run ID.');
    const initial=childResult(parentId,args.runId);
    if(name==='get_delegated_run')return initial;
    const seconds=args.timeoutSeconds??30;
    if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0||seconds>30)fail(400,'Wait timeout must be between 0 and 30 seconds.');
    if(terminal.has(initial.status)||seconds===0)return initial;
    await new Promise((resolve,reject)=>{
      let timer;const cleanup=()=>{clearTimeout(timer);changes.removeListener(args.runId,onChange);signal?.removeEventListener('abort',onAbort);};
      const onChange=()=>{if(terminal.has(raw(args.runId)?.status)){cleanup();resolve();}};
      const onAbort=()=>{cleanup();reject(new ApiError(409,'Parent run cancelled.'));};
      changes.on(args.runId,onChange);signal?.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>{cleanup();resolve();},seconds*1000);
      if(signal?.aborted)onAbort();else onChange();
    });
    return childResult(parentId,args.runId);
  }
  async function execute(row){
    const id=row.id,req=new EventEmitter(),res=new EventEmitter();
    const controller=new AbortController();const ctl={controller,req,decision:undefined};controls.set(id,ctl);
    let buffer='',text='',error,done,followUps,reasoningMs,knowledgeHints,toolRuns=[],patches=[],approvals=[],generatedFiles=[];
    req.aborted=false;res.destroyed=false;res.headersSent=false;
    res.writeHead=()=>{res.headersSent=true;};
    res.write=chunk=>{
      buffer+=chunk;
      let boundary;
      while((boundary=buffer.indexOf('\n\n'))>=0){
        const packet=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        if(!packet.startsWith('data: '))continue;
        const event=JSON.parse(packet.slice(6));
        if(event.type==='done'){done=event;continue;}
        if(event.type==='delta')text+=event.text;
        if(event.type==='suggestions' && validFollowUps(event.followUps))followUps=event.followUps;
        if(event.type==='reasoning_timing' && validReasoningMs(event.reasoningMs))reasoningMs=event.reasoningMs;
        if(event.type==='knowledge_hints' && validKnowledgeHints(event.knowledgeHints))knowledgeHints=event.knowledgeHints;
        if(event.type==='error')error=event.message;
        if(event.type==='artifact')patches.push(event.patch);
        if(event.type==='generated_file'&&generatedFiles.length<8&&!generatedFiles.some(f=>f.id===event.file?.id))generatedFiles.push(event.file);
        if(event.type==='approval')approvals.push(event.approval);
        if(event.type==='tool'){
          const at=toolRuns.findIndex(t=>t.id===event.id);if(at<0)toolRuns.push(event);else toolRuns[at]=event;
          if(event.status==='running')db.prepare('UPDATE agent_runs SET tool_count=tool_count+1 WHERE id=?').run(id);
        }
        append(id,event);
      }
      return true;
    };
    res.end=chunk=>{if(chunk)res.write(chunk);res.emit('finish');};
    const onAbort=()=>{req.aborted=true;req.emit('aborted');};controller.signal.addEventListener('abort',onAbort,{once:true});
    try {
      db.prepare('UPDATE agent_runs SET status=?,started=? WHERE id=?').run('running',stamp(),id);append(id,{type:'run_status',status:'running'});
      const stored=JSON.parse(row.request),readonly=!!stored._delegation;
      const approveAndRun=(action,executor,signal)=>propose(id,action,signal,executor);
      const skills=createManagedSkillTools({enabled:!readonly&&stored._runTools?.includes('Skills'),root:skillRoot||shellRoot||process.cwd(),catalog:skillCatalog,credentialProvider:skillCredentialProvider,approveAndRun});
      const files=createWorkspaceFileTools({enabled:readonly?[]:stored._runTools||[],root:path.resolve(dataDir,'agent-files',row.workspace_id),approveAndRun,persistFile:typeof persistGeneratedFile==='function'?input=>persistGeneratedFile({...input,mimeType:input.mimeType.split(';')[0],workspaceId:row.workspace_id}):undefined});
      const thread=scope(row),source=thread.messages?.find(m=>m.id===row.message_id);
      if(!source || digest(source.text)!==row.source_hash)throw new ApiError(409,'The source message changed before execution.');
      await llm.chat(req,res,chatRequest(stored),{runId:id,timeoutMs,maxRounds:24,maxTools:64,maxConcurrent:maxConcurrent+CHILD_SLOTS,
        ...(readonly?{readOnly:true,allowedTools:[...stored._delegation.allowedTools]}:{}),
        skills:{...skills,execute:(name,args,signal)=>skills.execute(name,args,{signal})},files,
        tools:{definitions:[planDefinition,...(!readonly&&stored._runTools?.includes('Delegation')?delegationDefinitions(load().state.workspaces.find(workspace=>workspace.id===row.workspace_id).data.agents):[])],execute:async(_name,args)=>{
        if(_name!=='update_plan')return delegationTool(id,_name,args,controller.signal);
        validateManagedPlan(args,{previousSteps:raw(id).plan?JSON.parse(raw(id).plan):[],childRun:childId=>{const child=raw(childId);return child?.parent_run_id===id && child.workspace_id===row.workspace_id?{status:child.status,resultSaved:!!child.result_saved}:undefined;}});
        scope(raw(id));db.prepare('UPDATE agent_runs SET plan=? WHERE id=?').run(JSON.stringify(args.steps),id);append(id,{type:'plan',steps:args.steps});return {recorded:true,steps:args.steps};
      }},...(!readonly?{shell:{definitions:[definition],execute:(_name,args,signal)=>propose(id,args,signal)}}:{})});
    } catch(e){error=e instanceof ApiError?e.message:'The managed run could not complete. No automatic replay was attempted.';append(id,{type:'error',message:error});}
    finally {
      controller.signal.removeEventListener('abort',onAbort);
      // Finishing the parent's text stream is not evidence that delegated work
      // finished. Prevent an early answer from leaving active, orphaned children.
      if(done && !error && !controller.signal.aborted && !closed && db.prepare("SELECT 1 FROM agent_runs WHERE parent_run_id=? AND status IN ('queued','running','waiting_approval') LIMIT 1").get(id))
        error='The run ended before its delegated children finished. Review child results before continuing.';
      const status=closed?'interrupted':controller.signal.aborted?'cancelled':done&&!error?'succeeded':'failed';
      if(!error && status!=='succeeded')error=status==='cancelled'?'Run cancelled by the user.':'Generation did not complete.';
      if(status!=='succeeded'){
        const descendants=db.prepare('WITH RECURSIVE tree(id) AS (SELECT id FROM agent_runs WHERE parent_run_id=? UNION ALL SELECT r.id FROM agent_runs r JOIN tree t ON r.parent_run_id=t.id) SELECT id FROM tree').all(id);
        for(const item of descendants){const child=raw(item.id);if(!child||terminal.has(child.status))continue;const ctl=controls.get(item.id);if(ctl)ctl.controller.abort();else{db.prepare("UPDATE agent_runs SET status='cancelled',finished=?,error=? WHERE id=?").run(stamp(),'Parent run did not complete successfully.',item.id);append(item.id,{type:'run_status',status:'cancelled'});}}
      }
      let saved=false;
      try {saved=persist({id,request:chatRequest(JSON.parse(row.request)),sourceHash:row.source_hash,status,text,toolRuns,...(status==='succeeded'?{followUps,reasoningMs,knowledgeHints}:{}),generatedFiles:status==='succeeded'&&!JSON.parse(row.request)._delegation?generatedFiles:[],patches:status==='succeeded'&&!JSON.parse(row.request)._delegation?patches:[],approvals:status==='succeeded'&&!JSON.parse(row.request)._delegation?approvals:[],error});}
      catch {error='The run output is preserved in the event log, but saving the answer/artifacts conflicted. Reload the workspace and inspect this run.';}
      db.prepare('UPDATE agent_runs SET status=?,finished=?,model=?,error=?,usage=?,result_saved=? WHERE id=?').run(status,stamp(),done?.model || null,error || null,done?.usage?JSON.stringify(done.usage):null,saved?1:0,id);
      db.prepare("UPDATE shell_actions SET status='cancelled' WHERE run_id=? AND status IN ('pending','approved')").run(id);
      if(done && status==='succeeded')append(id,done);
      append(id,{type:'run_status',status});eventBudgets.delete(id);controls.delete(id);queueMicrotask(pump);
    }
  }
  function pump(){
    if(closed||pumping)return;pumping=true;
    try{for(const child of [false,true]){
      const limit=child?CHILD_SLOTS:maxConcurrent;
      while([...controls.keys()].filter(id=>!!raw(id).parent_run_id===child).length<limit){
        const row=db.prepare(`SELECT * FROM agent_runs WHERE status='queued' AND parent_run_id IS ${child?'NOT ':''}NULL ORDER BY created,rowid LIMIT 1`).get();
        if(!row)break;void execute(row);
      }
    }}
    finally{pumping=false;}
  }
  async function admit(request,delegation,continuation){
      if(closed)fail(503,'Run service is closing.');
      // Validate fields and workspace resources before looking up or queuing work.
      if(!llm.config().configured)fail(503,'The model provider is not configured.');
      if(!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(k=>!['workspaceId','threadId','userMessageId','model'].includes(k)) || !['workspaceId','threadId','userMessageId'].every(k=>typeof request[k]==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(request[k])))fail(400,'Invalid run request.');
      if(Object.hasOwn(request,'model') && !MODELS.includes(request.model) && !llm.config().models.includes(request.model))fail(422,'Unsupported model.');
      let parent=null, depth=0, rootRunId=null;
      if(delegation){parent=authorizedParent(delegation.parentId);budget(parent);depth=parent.depth+1;rootRunId=parent.root_run_id||parent.id;}
      const existing=db.prepare('SELECT * FROM agent_runs WHERE workspace_id=? AND thread_id=? AND message_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(request.workspaceId,request.threadId,request.userMessageId);
      if(existing){scope(existing);if(delegation&&JSON.parse(existing.request)._delegation?.key!==delegation.key)fail(409,'Child thread already has unrelated work.');return info(existing);}
      const conversation=await buildConversation(load().state,request,readAttachment,llm.config());
      if(validateAdmission)validateAdmission(load().state,request);
      const raced=db.prepare('SELECT * FROM agent_runs WHERE workspace_id=? AND thread_id=? AND message_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(request.workspaceId,request.threadId,request.userMessageId);
      if(raced){scope(raced);if(delegation&&JSON.parse(raced.request)._delegation?.key!==delegation.key)fail(409,'Child thread already has unrelated work.');return info(raced);}
      if(!parent && db.prepare("SELECT id FROM agent_runs WHERE workspace_id=? AND thread_id=? AND status IN ('queued','running','waiting_approval')").get(request.workspaceId,request.threadId))fail(409,'This thread already has an active run.');
      if(db.prepare("SELECT count(*) AS n FROM agent_runs WHERE status IN ('queued','running','waiting_approval')").get().n>=20)fail(429,'Run queue is full.');
      const snapshot=load().state,thread=snapshot.workspaces.find(w=>w.id===request.workspaceId).data.threads.find(t=>t.id===request.threadId);
      const source=thread.messages.find(m=>m.id===request.userMessageId),settings=source.context?.settings||thread.config||snapshot.workspaces.find(w=>w.id===request.workspaceId).data.preferences?.defaultThreadSettings||{};
      const stored={...request,_runTools:[...(settings.tools||[])],...(delegation?{_delegation:delegation}:{}),...(continuation?{_continuation:continuation}:{})};
      if(parent){parent=authorizedParent(parent.id);budget(parent);}
      const id=randomUUID();const tx=db;try{tx.exec('BEGIN IMMEDIATE');if(parent){const live=tx.prepare('SELECT child_count,depth,status FROM agent_runs WHERE id=?').get(parent.id);if(!live||terminal.has(live.status)||live.depth>=MAX_DEPTH||live.child_count>=MAX_CHILDREN)throw new ApiError(429,'Child admission budget exhausted.');tx.prepare('UPDATE agent_runs SET child_count=child_count+1 WHERE id=?').run(parent.id);}tx.prepare('INSERT INTO agent_runs (id,workspace_id,thread_id,message_id,source_hash,request,status,created,model,parent_run_id,root_run_id,depth) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,request.workspaceId,request.threadId,request.userMessageId,digest(source.text),JSON.stringify(stored),'queued',stamp(),conversation.model,parent?.id||null,rootRunId,depth);tx.exec('COMMIT');}catch(e){try{tx.exec('ROLLBACK')}catch{};throw e;}finally{}
      append(id,{type:'run_status',status:'queued'});queueMicrotask(pump);return info(raw(id));
  }
  async function continueRun(id,request){
    if(closed)fail(503,'Run service is closing.');
    if(!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(k=>!['workspaceId','threadId','requestId'].includes(k))
      || !['workspaceId','threadId','requestId'].every(k=>typeof request[k]==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(request[k])))fail(400,'Workspace, thread and a stable requestId are required.');
    const original=raw(id),thread=scope(original,request);
    if(original.parent_run_id)fail(409,'Continue the main run rather than an isolated delegated run.');
    const messageId='message-continue-'+digest(JSON.stringify([id,request.requestId]));
    const prior=db.prepare('SELECT * FROM agent_runs WHERE workspace_id=? AND thread_id=? AND message_id=?').get(request.workspaceId,request.threadId,messageId);
    if(prior){scope(prior,request);if(JSON.parse(prior.request)._continuation?.sourceRunId!==id)fail(409,'Continuation identity conflicts.');return info(prior);}
    if(!['failed','interrupted','cancelled'].includes(original.status))fail(409,'Only an interrupted, failed or stopped run can be continued.');
    if(typeof createContinuationMessage!=='function')fail(503,'Saved-context continuation is not configured.');
    if(!llm.config().configured)fail(503,'The model provider is not configured.');
    const latest=db.prepare('SELECT id FROM agent_runs WHERE workspace_id=? AND thread_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(request.workspaceId,request.threadId);
    if(latest?.id!==id)fail(409,'This thread has a newer run. Continue the latest saved run.');
    const inFlight=continuing.get(id);
    if(inFlight){if(inFlight.requestId!==request.requestId)fail(409,'A continuation is already being saved. Retry the same request.');return inFlight.work;}
    const source=thread.messages?.find(message=>message.id===original.message_id);
    if(!source || digest(source.text)!==original.source_hash)fail(409,'The original request changed. Review this thread before continuing.');
    let goalSource=source,ancestor=original;
    // Keep the human's goal at the start even after several continuations. This
    // avoids nesting generated snapshots and preserves the goal for small models.
    for(let depth=0;depth<32;depth++){
      const previous=JSON.parse(ancestor.request)._continuation?.sourceRunId;
      if(!previous)break;
      const prior=raw(previous),message=prior&&thread.messages?.find(message=>message.id===prior.message_id);
      if(!prior||prior.workspace_id!==original.workspace_id||prior.thread_id!==original.thread_id||!message||digest(message.text)!==prior.source_hash)break;
      goalSource=message;ancestor=prior;
    }
    const tools=new Map();let partial='';
    for(const item of db.prepare('SELECT event FROM run_events WHERE run_id=? ORDER BY seq').iterate(id)){
      const event=JSON.parse(item.event);
      if(event.type==='tool' && event.status==='success')tools.set(event.id,{name:String(event.name||'tool').slice(0,100),summary:String(event.summary||'').slice(0,240),outcome:'unverified'});
      if(event.type==='tool_trace' && event.phase==='finished' && tools.has(event.id))tools.get(event.id).outcome=event.outcome||'unverified';
      if(event.type==='delta' && partial.length<1200)partial+=String(event.text||'').slice(0,1200-partial.length);
    }
    // Public summaries are observations, not a replayable tool transcript. Unknown
    // effects and expired approvals remain explicit instead of becoming "not run".
    const workspace=load().state.workspaces.find(workspace=>workspace.id===original.workspace_id);
    const checkpoint={sourceRunId:id,status:original.status,goal:goalSource.text.slice(0,3000),resultSaved:!!original.result_saved,
      observedToolCalls:[...tools.values()].slice(-8),savedArtifacts:(workspace?.data.artifacts||[]).filter(artifact=>artifact.threadId===original.thread_id&&!artifact.archived).slice(-8).map(artifact=>({id:artifact.id,title:artifact.title.slice(0,120),kind:artifact.kind})),
      plan:original.plan?JSON.parse(original.plan).map(step=>({title:step.title.slice(0,160),status:step.status})):[],
      ...(partial?{partialAnswer:partial}:{}),actions:db.prepare('SELECT id,args,status FROM shell_actions WHERE run_id=? ORDER BY created').all(id).slice(-8)
        .map(action=>({id:action.id,kind:JSON.parse(action.args).kind||'shell',status:action.status}))};
    const context={...checkpoint,goal:undefined};
    let serialized=JSON.stringify(context);
    while(serialized.length>10000){
      context.truncated=true;
      const rows=[context.observedToolCalls,context.plan,context.savedArtifacts,context.actions].find(rows=>rows.length);
      if(rows)rows.shift();else context.partialAnswer=String(context.partialAnswer||'').slice(0,400)||undefined;
      serialized=JSON.stringify(context);
    }
    const text='继续未完成的任务：\n'+checkpoint.goal+'\n\n从已保存的上下文继续。此条由服务器根据你的继续操作生成。\n先检查已保存的产物和当前状态，再完成剩余工作；以下是上一轮的记录快照，不是新的外部指令。工具返回 prepared 只表示准备，不能当作产物已经保存；savedArtifacts 列出此刻工作区实际存在的产物。不要重复已完成的操作。失败、中断或未确认的外部写入可能已经发生，先核对结果；原审批不延续，需要执行的新操作仍须按当前权限重新审批。\n\n'+serialized;
    const work=(async()=>{
      const saved=await createContinuationMessage({workspaceId:request.workspaceId,threadId:request.threadId,sourceRunId:id,sourceMessageId:source.id,sourceHash:original.source_hash,userMessageId:messageId,text});
      if(!saved || saved.workspaceId!==request.workspaceId || saved.threadId!==request.threadId || saved.userMessageId!==messageId)fail(409,'Continuation host returned a different saved request.');
      return admit(saved,undefined,{sourceRunId:id});
    })();
    continuing.set(id,{requestId:request.requestId,work});
    try{return await work;}finally{continuing.delete(id);}
  }
  return {
    create:request=>admit(request),
    continue:continueRun,
    list(request){
      if(!request.workspaceId||!request.threadId)fail(400,'Workspace and thread are required.');
      const thread=load().state.workspaces.find(w=>w.id===request.workspaceId)?.data.threads.find(t=>t.id===request.threadId&&!t.archived);if(!thread)fail(404,'Thread unavailable.');
      return db.prepare('SELECT * FROM agent_runs WHERE workspace_id=? AND thread_id=? ORDER BY created DESC,rowid DESC LIMIT 20').all(request.workspaceId,request.threadId).map(info);
    },
    get(id,request){const row=raw(id);scope(row,request);return info(row);},
    events(id,request,after=0){
      const row=raw(id);scope(row,request);if(!Number.isSafeInteger(after)||after<0)fail(400,'Invalid event cursor.');
      const events=db.prepare('SELECT seq,event FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200').all(id,after).map(e=>({seq:e.seq,event:JSON.parse(e.event)}));
      const nextCursor=events.at(-1)?.seq ?? after;
      return {run:info(row),events,nextCursor,hasMore:!!db.prepare('SELECT 1 FROM run_events WHERE run_id=? AND seq>? LIMIT 1').get(id,nextCursor)};
    },
    cancel(id,request){const row=raw(id);scope(row,request);const ids=db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT r.id FROM agent_runs r JOIN tree t ON r.parent_run_id=t.id) SELECT id FROM tree`).all(id).map(x=>x.id);for(const childId of ids){const child=raw(childId);if(!child||terminal.has(child.status))continue;const ctl=controls.get(childId);if(ctl)ctl.controller.abort();else{db.prepare("UPDATE agent_runs SET status='cancelled',finished=?,error=? WHERE id=?").run(stamp(),'Run cancelled with its parent.',childId);append(childId,{type:'run_status',status:'cancelled'});}}return info(raw(id));},
    decide(id,actionId,request){
      const row=raw(id);scope(row,request);if(!['approve','deny'].includes(request.decision))fail(422,'Decision must be approve or deny.');
      const action=db.prepare('SELECT * FROM shell_actions WHERE id=? AND run_id=?').get(actionId,id);if(!action)fail(404,'Approval not found.');
      if(action.status!=='pending')return info(row); // Idempotent: never run a command twice.
      const ctl=controls.get(id);if(!ctl?.decision||ctl.decision.actionId!==actionId||terminal.has(row.status))fail(409,'Approval is no longer active.');
      db.prepare('UPDATE shell_actions SET status=? WHERE id=?').run(request.decision==='approve'?'approved':'denied',actionId);ctl.decision.resolve(request.decision==='approve');return info(raw(id));
    },
    tree(id,request){const row=raw(id);scope(row,request);const root=row.root_run_id||row.id;const rows=db.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT r.id FROM agent_runs r JOIN tree t ON r.parent_run_id=t.id) SELECT * FROM agent_runs WHERE id IN (SELECT id FROM tree) ORDER BY depth,created LIMIT ${MAX_TREE}`).all(root);return {rootRunId:root,runs:rows.map(info),truncated:rows.length>=MAX_TREE};},
    createChild(){fail(400,'Use the authorized delegate_agent managed tool with a separate saved child thread.');},
    capabilities:()=>({durable:true,continuation:{available:typeof createContinuationMessage==='function',explicit:true,replaysActions:false},concurrency:maxConcurrent,delegation:{available:typeof createDelegatedThread==='function',childSlots:CHILD_SLOTS,maxChildren:MAX_CHILDREN,maxTree:MAX_TREE,maxDepth:MAX_DEPTH},maxRunSeconds:timeoutMs/1000,maxToolCalls:64,maxRounds:24,files:{available:true,workspaceScoped:true,approvalRequired:true},skills:{available:skillCatalog.length>0,installed:skillCatalog.length,approvalRequired:true},shell:{available:true,root:shellRoot,approvalRequired:true,maxCommandSeconds:300},browser:false}),
    async close(){closed=true;for(const ctl of controls.values())ctl.controller.abort();while(controls.size)await new Promise(resolve=>setTimeout(resolve,10));db.close();}
  };
}
