import { buildCapabilityManifest } from './capability-authority.mjs';
import catalog from '../shared/marketplace-catalog.json' with { type: 'json' };
import { createPublicTools } from './public-tools.mjs';
export const marketplaceCatalog = catalog;
export function marketplaceCapabilities({deepseekConfigured=false,openAlexApiKey,exaApiKey,userAgent,moliPath,browserProvider,browserPath}={}) {
  const manifest=buildCapabilityManifest({deepseekConfigured,openAlexApiKey,exaApiKey,userAgent,moliPath,browserProvider,browserPath});
  const capabilities=Object.fromEntries(manifest.capabilities.map(c=>[c.label,{available:c.implemented&&c.configured,reason:c.reason || (c.executable?'Executable tool is available.':'Implemented but not authorized for this run.')} ]));
  capabilities.LLM={available:deepseekConfigured,reason:deepseekConfigured?'Server-side DeepSeek key is present; provider authorization is verified only by a real request.':'Set DEEPSEEK_API_KEY on the server before running a skill.'};
  for(const item of createPublicTools({enabled:["World Bank","Weather","OpenAlex"],openAlexApiKey,userAgent}).capabilities) capabilities[item.service]={available:item.configured,reason:item.reason + " Adapter configuration only; upstream reachability is checked on use."};
  for(const entry of catalog.entries)for(const name of entry.dependencies)if(!capabilities[name])capabilities[name]={available:false,reason:'Not implemented or connected in this replica. No execution is simulated.'};
  return {capabilities,inventory:{skills:catalog.entries.filter(e=>e.kind==='skill').length,agents:catalog.entries.filter(e=>e.kind==='agent').length,categories:catalog.categories.length,implementations:catalog.entries.filter(e=>e.implementation).length},cataloguedAt:'2026-10-28'};
}
/** Selected installation resolves to our exact authored template, not arbitrary imported metadata. */
export function requiredSkillTools(snapshot,request) {
  const data=snapshot.workspaces.find(w=>w.id===request.workspaceId)?.data;
  const thread=data?.threads.find(t=>t.id===request.threadId),message=thread?.messages?.at(-1);
  if(!data || !message)return [];
  const settings=message.context?.settings || thread.config || {};
  const agent=settings.agentId ? data.agents.find(a=>a.id===settings.agentId && !a.archived) : undefined;
  const ids=new Set([...(message.context?.skillIds || []),...(agent?.skillIds || [])]);
  const tools=new Set();
  for(const skill of data.skills.filter(s=>ids.has(s.id) && !s.archived)) {
    const source=catalog.entries.find(e=>e.kind==='skill' && e.sourceId===skill.sourceId && e.implementation);
    if(source && skill.documentation===source.implementation.documentation)for(const tool of source.implementation.tools)tools.add(tool);
  }
  if(agent && agent.id.startsWith('agent-market-')) {
    const source=catalog.entries.find(e=>e.kind==='agent' && 'agent-market-'+e.sourceId===agent.id && e.implementation);
    if(source && agent.prompt===source.implementation.documentation)for(const tool of source.implementation.tools)tools.add(tool);
  }
  return [...tools];
}
