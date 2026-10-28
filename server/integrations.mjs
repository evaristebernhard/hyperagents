import {createCoreIntegrations} from './integrations-core.mjs';
import {createGoogleIntegrations} from './integrations-google.mjs';
import {createExtraIntegrations} from './integrations-extra.mjs';
import {createIntegrationHttp,validateArguments} from './integration-http.mjs';
const CREDENTIAL_NAMES=['GITHUB_TOKEN','SLACK_BOT_TOKEN','NOTION_TOKEN','AIRTABLE_TOKEN','GOOGLE_ACCESS_TOKEN','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','TELEGRAM_BOT_TOKEN','LINEAR_API_KEY','STRIPE_SECRET_KEY','ASANA_TOKEN'];
export function captureIntegrationCredentials(env){const credentials={};for(const name of CREDENTIAL_NAMES){if(env[name]!==undefined)credentials[name]=env[name];delete env[name];}return credentials;}
const ORIGINS={github:'https://api.github.com',slack:'https://slack.com',notion:'https://api.notion.com',airtable:'https://api.airtable.com',telegram:'https://api.telegram.org',linear:'https://api.linear.app',stripe:'https://api.stripe.com',asana:'https://app.asana.com','google-gmail':'https://gmail.googleapis.com','google-calendar':'https://www.googleapis.com','google-drive':'https://www.googleapis.com','google-docs':'https://docs.googleapis.com','google-sheets':'https://sheets.googleapis.com'};
export function createIntegrationRegistry({credentials={},fetchImpl,load}={}) {
 const http=createIntegrationHttp(fetchImpl);
 const providers=[...createCoreIntegrations({credentials,http}),...createGoogleIntegrations({credentials,http}),...createExtraIntegrations({credentials,http})];
 const find=id=>providers.find(p=>p.id===id);
 return {
  provider:find,
  statuses:()=>({providers:providers.map(p=>({id:p.id,name:p.name,configured:p.configured,env:p.env,endpoint:ORIGINS[p.id],operations:p.operations.map(op=>({name:op.name,type:op.type,description:op.description})),authentication:'Server-owned API credentials. Connection testing does not import a Hyperagent login or perform a fake OAuth flow.'}))}),
  async test(id,signal){const provider=find(id);if(!provider)throw Error('This integration has no API adapter yet.');if(!provider.configured)throw Error('Set the server credential variables before testing '+provider.name+'.');const result=await provider.test(signal);return {providerId:id,provider:provider.name,accountLabel:typeof result?.accountLabel==='string'?result.accountLabel.slice(0,300):provider.name,testedAt:new Date().toISOString(),endpoint:ORIGINS[id]};},
  bind(snapshot,request,broker){
   const ws=snapshot.workspaces.find(w=>w.id===request.workspaceId),thread=ws?.data.threads.find(t=>t.id===request.threadId),message=thread?.messages?.at(-1);
   const selected=message?.context?.integrationIds||[],byProvider=new Map();
   if(selected.length>8)throw Error('Select at most eight integrations per task.');
   for(const id of new Set(selected)){
    const c=ws.data.connections.find(c=>c.id===id&&c.enabled);if(!c)throw Error('A selected integration is disabled or no longer in this workspace.');
    const provider=providers.find(p=>p.name===c.provider);if(!provider)throw Error(c.provider+' is only metadata; no API adapter is implemented.');if(!provider.configured)throw Error(provider.name+' is not configured on the server.');
    const group=byProvider.get(provider.id)||{provider,connections:[]};group.connections.push(c.id);byProvider.set(provider.id,group);
   }
   const bindings=new Map(),definitions=[];
   for(const {provider,connections}of byProvider.values())for(const op of provider.operations){
    const name=op.type==='write'?'prepare_'+op.name:op.name;
    if(bindings.has(name))throw Error('Integration tool names must be unique.');
    const parameters={...op.parameters,properties:{connectionId:{type:'string',enum:connections},...(op.parameters.properties||{})},required:['connectionId',...(op.parameters.required||[])],additionalProperties:false};
    definitions.push({type:'function',function:{name,description:op.type==='write'?'Prepare an action for explicit human confirmation. This does not execute the write. '+op.description:op.description,parameters}});
    bindings.set(name,{provider,op,connections,parameters});
   }
   return {definitions,async execute(name,args,signal){
    const binding=bindings.get(name);if(!binding)throw Error('Integration tool is not available.');validateArguments(binding.parameters,args);
    const {connectionId,...parameters}=args;const {provider,op}=binding;
    const live=typeof load==='function'?load().state:snapshot;
    const liveWs=live.workspaces.find(w=>w.id===request.workspaceId),liveThread=liveWs?.data.threads.find(t=>t.id===request.threadId&&!t.archived),liveMessage=liveThread?.messages?.at(-1);
    if(!liveMessage||liveMessage.id!==request.userMessageId||!liveMessage.context?.integrationIds?.includes(connectionId)||!liveWs.data.connections.some(c=>c.id===connectionId&&c.enabled&&c.provider===provider.name))throw Error('The selected integration binding changed or was disabled before execution.');
    if(op.type==='read')return {result:await provider.run(op.name,parameters,signal)};
    const approval=broker.prepare({workspaceId:request.workspaceId,threadId:request.threadId,connectionId,providerId:provider.id,operation:op.name,args:parameters});
    return {approval,result:{status:'approval_required',id:approval.id,provider:provider.name,operation:op.name,message:'No write has been performed. The user must confirm the exact action in the application.'}};
   }};
  }
 };
}
