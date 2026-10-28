import { ApiError, validateState, arrays } from './validation.mjs';
export function prepareLegacy(input,findFile) {
  if(!input || input.version!==1 || !Array.isArray(input.workspaces)) throw new ApiError(422,'Unsupported browser backup.','MIGRATION');
  const state=structuredClone(input),warnings=[];let omitted=0;
  const warn=text=>{if(warnings.length<200)warnings.push(text);else omitted++;};
  for(const w of state.workspaces) {
    if(!w || !w.data || typeof w.name!=='string') throw new ApiError(422,'Invalid browser workspace.','MIGRATION');
    const d=w.data;
    if(d.connections===undefined){d.connections=[];warn(`${w.name}: added the previously absent connection list.`);}
    if(arrays.some(key=>!Array.isArray(d[key]))) throw new ApiError(422,'Browser backup is missing a resource collection.','MIGRATION');
    const ids=Object.fromEntries(arrays.filter(k=>k!=='reviewedSuggestions').map(k=>[k,new Set(d[k].map(x=>x?.id))]));
    const unlink=(obj,field,collection,label)=>{
      if(obj && typeof obj[field]==='string' && !ids[collection].has(obj[field])) {
        warn(`${w.name}: unlinked missing ${collection} reference from ${label} (${obj[field]}). Original records are kept.`);delete obj[field];return true;
      }
      return false;
    };
    for(const t of d.threads) {
      if(!t || typeof t!=='object')continue;
      unlink(t,'projectId','projects',`thread ${t.id}`);unlink(t,'roomId','rooms',`thread ${t.id}`);unlink(t.config,'agentId','agents',`thread ${t.id} settings`);
      for(const m of Array.isArray(t.messages)?t.messages:[]) {
        if(Array.isArray(m?.context?.attachments) && m.context.attachments.length) throw new ApiError(422,'This backup contains attachment references. Browser migration cannot copy binary files. Keep the original backup and data directory; create an explicit metadata-only copy without attachment references if you want to import its text. No attachment was removed.','MIGRATION_ATTACHMENTS');
      }
    }
    for(const a of d.artifacts) {unlink(a,'threadId','threads',`artifact ${a?.id}`);unlink(a,'projectId','projects',`artifact ${a?.id}`);}
    for(const r of d.rooms) if(Array.isArray(r?.agentIds)) {const missing=r.agentIds.filter(id=>typeof id==='string'&&!ids.agents.has(id));if(missing.length){r.agentIds=r.agentIds.filter(id=>!missing.includes(id));warn(`${w.name}: unlinked ${missing.length} missing agents from room ${r.id}.`);}}
    for(const s of d.schedules) if(s && typeof s==='object') {const a=unlink(s,'agentId','agents',`schedule ${s.id}`),r=unlink(s,'roomId','rooms',`schedule ${s.id}`);if(a||r)s.enabled=false;}
    for(const a of d.agents) if(Array.isArray(a?.skillIds)) {const missing=a.skillIds.filter(id=>typeof id==='string'&&!ids.skills.has(id));if(missing.length){a.skillIds=a.skillIds.filter(id=>!missing.includes(id));warn(`${w.name}: unlinked ${missing.length} missing skills from agent ${a.id}.`);}}
    unlink(d.preferences?.defaultThreadSettings,'agentId','agents','default thread settings');
  }
  if(omitted)warnings.push(`${omitted} additional missing-link warnings omitted. No resource records were removed.`);
  validateState(state,findFile);
  return {state,warnings};
}
