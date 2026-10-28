import {randomBytes,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {validateArguments} from './integration-http.mjs';
export function createApprovalBroker({load,registry,ttlMs=10*60*1000}) {
 const secret=randomBytes(32),states=new Map();
 const sign=body=>createHmac('sha256',secret).update(body).digest('base64url');
 const purge=()=>{for(const [id,row]of states)if(row.expires<Date.now())states.delete(id);};
 function binding(payload){
  const ws=load().state.workspaces.find(w=>w.id===payload.workspaceId);const thread=ws?.data.threads.find(t=>t.id===payload.threadId&&!t.archived);
  const connection=ws?.data.connections.find(c=>c.id===payload.connectionId&&c.enabled);
  const provider=registry.provider(payload.providerId),operation=provider?.operations.find(op=>op.name===payload.operation&&op.type==='write');
  if(!thread||!connection||!provider||connection.provider!==provider.name||!provider.configured||!operation)throw Error('The approved integration is unavailable, disabled or no longer in this workspace.');
  validateArguments(operation.parameters,payload.args);return {provider,operation};
 }
 return {
  prepare(request){purge();if(states.size>=1000)throw Error('Too many pending integration actions.');const payload={...request,id:randomUUID(),expires:Date.now()+ttlMs};binding(payload);const body=Buffer.from(JSON.stringify(payload)).toString('base64url');if(body.length>65000)throw Error('Approval request is too large.');const token=body+'.'+sign(body);states.set(payload.id,{status:'pending',expires:payload.expires});return {id:payload.id,token,provider:registry.provider(payload.providerId).name,operation:payload.operation,summary:registry.provider(payload.providerId).name+' · '+payload.operation,args:payload.args,status:'pending'};},
  async execute(token,scope){
   purge();if(typeof token!=='string'||token.length>66000)throw Error('Invalid or expired action approval.');const parts=token.split('.');if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]{43}$/.test(parts[1]))throw Error('Invalid or expired action approval.');const expected=Buffer.from(sign(parts[0])),actual=Buffer.from(parts[1]);if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw Error('Invalid or expired action approval.');let payload;try{payload=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw Error('Invalid or expired action approval.');}
   if(!scope||scope.workspaceId!==payload.workspaceId||scope.threadId!==payload.threadId)throw Error('Action approval does not belong to this thread and workspace.');
   const row=states.get(payload.id);if(!row||payload.expires<Date.now())throw Error('Action approval expired or the server restarted. Request a fresh action.');
   if(row.status==='completed')return {id:payload.id,status:'completed',result:row.result,replayed:true};
   if(row.status!=='pending')throw Error(row.status==='executing'?'This action is already executing.':'The previous attempt may have reached the service. Verify there before requesting another action.');
   const {provider}=binding(payload);row.status='executing';
   try{const result=await provider.run(payload.operation,payload.args);const safe=JSON.stringify(result);if(safe.length>64000)throw Error('Integration result is too large.');row.status='completed';row.result=result;return {id:payload.id,status:'completed',result};}
   catch{row.status='unknown';throw Error('The action failed or its result could not be confirmed. It will not be retried automatically; verify the service before requesting a new action.');}
  }
 };
}
