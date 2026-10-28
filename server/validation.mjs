export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const fail = (message = 'Invalid workspace snapshot.') => { throw new ApiError(422, message, 'VALIDATION'); };
export const arrays = ['threads','projects','agents','memories','skills','rooms','artifacts','schedules','rubrics','reviewedSuggestions','connections'];
export const emptyState = () => ({version:1, active:'personal',workspaces:[{id:'personal',name:'Personal',data:Object.fromEntries(arrays.map(k=>[k,[]]))}]});
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = x => typeof x === 'string';
const id = x => str(x) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(x);
const list = (x, test) => Array.isArray(x) && x.length <= 10000 && x.every(test);
function keys(x, allowed) { if (!obj(x) || Object.keys(x).some(k=>!allowed.includes(k))) fail(); }
function json(x, depth = 0) {
  if (depth > 20) fail('Metadata nesting is too deep.');
  if (x === null || str(x) || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return;
  if (Array.isArray(x)) { if (x.length > 10000) fail(); x.forEach(v=>json(v,depth+1)); return; }
  if (!obj(x) || Object.keys(x).length > 1000) fail();
  for (const [k,v] of Object.entries(x)) { if (['__proto__','prototype','constructor'].includes(k)) fail(); json(v,depth+1); }
}
const specs = {
  threads: {required:'title summary time', strings:'project roomId notes createdAt updatedAt projectId', bools:'starred archived excluded', extra:'messages config'},
  projects: {required:'name description goal', strings:'',bools:'archived'},
  agents: {required:'name description prompt', strings:'promptHtml memoryReadScope memorySaveTarget model provider reasoning memoryMode',bools:'learnsAutomatically libraryEnabled archived starred',extra:'tools skillIds learning'},
  memories: {required:'content category',strings:'whenToUse scope',bools:'pinned',extra:'importance tags'},
  skills: {required:'name description documentation whenToUse author createdAt updatedAt',strings:'sourceId',bools:'archived',extra:'tags'},
  rooms: {required:'name topic',strings:'',bools:'archived',extra:'agentIds notes'},
  artifacts: {required:'title kind content createdAt updatedAt',strings:'threadId projectId',bools:'archived',extra:'versions'},
  schedules: {required:'name instructions cadence',strings:'agentId roomId',bools:'enabled'},
  rubrics: {required:'name',extra:'criteria'},
  connections: {required:'provider label endpoint createdAt',bools:'enabled'},
};
const words = s => (s || '').split(' ').filter(Boolean);
function strings(x) { if (!list(x,str)) fail(); }
function settings(c) {
  keys(c,['model','reasoning','provider','mode','agentId','starterAgentName','tools','outputFormat','visuals']);
  for (const k of ['model','reasoning','provider','mode']) if (!str(c[k])) fail('Invalid thread settings.');
  for (const k of ['agentId','starterAgentName','outputFormat','visuals']) if (c[k] !== undefined && !str(c[k])) fail('Invalid thread settings.');
  strings(c.tools);
}

function fileMeta(f, workspaceId, findFile) {
  keys(f,['id','name','size','mimeType','createdAt','workspaceId']);
  if (!id(f.id) || !str(f.name) || !str(f.mimeType) || !str(f.createdAt) || !Number.isSafeInteger(f.size) || f.size < 0 || f.workspaceId !== workspaceId) fail('Invalid attachment metadata.');
  const stored = findFile(f.id, workspaceId);
  if (!stored || ['name','size','mimeType','createdAt','workspaceId'].some(k=>stored[k] !== f[k])) fail('Attachment bytes are missing or metadata does not match.');
}
export function validateState(state, findFile = () => undefined) {
  keys(state,['version','active','workspaces']);
  if (state.version !== 1 || !id(state.active) || !Array.isArray(state.workspaces) || !state.workspaces.length || state.workspaces.length > 50) fail();
  json(state);
  const wsIds = new Set();
  for (const w of state.workspaces) {
    keys(w,['id','name','data']);
    if (!id(w.id) || wsIds.has(w.id) || !str(w.name) || !w.name.trim() || w.name.length > 200) fail();
    wsIds.add(w.id); keys(w.data,[...arrays,'preferences']);
    if (w.data.preferences !== undefined && !obj(w.data.preferences)) fail();
    if (w.data.preferences?.defaultThreadSettings !== undefined) settings(w.data.preferences.defaultThreadSettings);
    const sets = {};
    for (const key of arrays) {
      const a = w.data[key];
      if (!Array.isArray(a) || a.length > 10000) fail('Invalid ' + key + '.');
      if (key === 'reviewedSuggestions') { strings(a); continue; }
      sets[key] = new Set();
      const s = specs[key];
      for (const item of a) {
        keys(item,['id',...words(s.required),...words(s.strings),...words(s.bools),...words(s.extra)]);
        if (!id(item.id) || sets[key].has(item.id)) fail('Invalid or duplicate resource ID.');
        sets[key].add(item.id);
        for (const k of words(s.required)) if (!str(item[k])) fail();
        for (const k of words(s.strings)) if (item[k] !== undefined && !str(item[k])) fail();
        for (const k of words(s.bools)) if (item[k] !== undefined && typeof item[k] !== 'boolean') fail();
        if (['schedules','connections'].includes(key) && typeof item.enabled !== 'boolean') fail();
        if (key === 'memories' && (!Number.isInteger(item.importance) || item.importance < 1 || item.importance > 5 || typeof item.pinned !== 'boolean')) fail();
        if (['skills','memories'].includes(key) && (key === 'skills' || item.tags !== undefined)) strings(item.tags);
        if (key === 'agents') {
          if (item.tools !== undefined) strings(item.tools);
          if (item.skillIds !== undefined) strings(item.skillIds);
          if (item.learning !== undefined && (!obj(item.learning) || !Object.values(item.learning).every(str))) fail();
        }
        if (key === 'rubrics') strings(item.criteria);
        if (key === 'rooms') {
          strings(item.agentIds);
          if (!list(item.notes,n=> { keys(n,['id','text','createdAt']); return id(n.id) && str(n.text) && str(n.createdAt); })) fail();
        }
        if (key === 'artifacts') {
          if (item.kind === 'Table') {
            let table;try {table=JSON.parse(item.content);}catch {fail('Invalid table JSON.');}
            if(!obj(table) || Object.keys(table).some(k=>!['columns','rows'].includes(k)) || !Array.isArray(table.columns) || !table.columns.length || table.columns.length>30 || !table.columns.every(str) || !Array.isArray(table.rows) || table.rows.length>500 || !table.rows.every(row=>Array.isArray(row) && row.length===table.columns.length && row.every(str))) fail('Invalid table data.');
          }
          if (!['Document','Webpage','Table','Image','File'].includes(item.kind) || !list(item.versions,v=> { keys(v,['id','content','createdAt']); return id(v.id) && str(v.content) && str(v.createdAt); })) fail();
        }
        if (key === 'threads') {
          if (item.config !== undefined) settings(item.config);
          if (item.messages !== undefined && !list(item.messages,m=> {
            keys(m,['id','role','text','createdAt','context','toolRuns']);
            if(m.toolRuns!==undefined && (!Array.isArray(m.toolRuns) || m.toolRuns.length>30 || !m.toolRuns.every(t=>{keys(t,['id','name','status','summary']);return id(t.id) && str(t.name) && ['running','success','error'].includes(t.status) && str(t.summary) && t.summary.length<=1600;}))) fail('Invalid tool history.');
            if (m.id !== undefined && !id(m.id)) fail();
            if (m.createdAt !== undefined && !str(m.createdAt)) fail();
            if (m.context !== undefined) {
              const c = m.context;
              keys(c,['settings','skillIds','memoryIds','artifactIds','integrationIds','projectId','attachments']);
              if (c.settings !== undefined) settings(c.settings);
              for (const k of ['skillIds','memoryIds','artifactIds','integrationIds']) if (c[k] !== undefined) strings(c[k]);
              if (c.projectId !== undefined && !str(c.projectId)) fail();
              if (c.attachments !== undefined) { if (!Array.isArray(c.attachments) || c.attachments.length > 100) fail(); c.attachments.forEach(f=>fileMeta(f,w.id,findFile)); }
            }
            return ['user','assistant'].includes(m.role) && str(m.text);
          })) fail();
        }
      }
    }
    const ref = (collection,value) => { if (value !== undefined && !sets[collection].has(value)) fail('Invalid ' + collection + ' reference.'); };
    ref('agents',w.data.preferences?.defaultThreadSettings?.agentId);
    for (const t of w.data.threads) {
      ref('projects',t.projectId); ref('rooms',t.roomId); ref('agents',t.config?.agentId);
      // Message context is an immutable historical reference, not a live permission.
      // Deleted resources remain identifiable without blocking later edits/deletions.
      // New execution services must re-resolve and authorize resources before use.
      for (const m of t.messages || []) {
        const c=m.context || {};
        for (const value of [c.settings?.agentId,c.projectId,...(c.skillIds || []),...(c.memoryIds || []),...(c.artifactIds || []),...(c.integrationIds || [])]) if (value !== undefined && !id(value)) fail('Invalid historical resource ID.');
      }
    }
    for (const a of w.data.artifacts) { ref('threads',a.threadId); ref('projects',a.projectId); }
    for (const r of w.data.rooms) for (const a of r.agentIds) ref('agents',a);
    for (const s of w.data.schedules) { ref('agents',s.agentId); ref('rooms',s.roomId); }
    for (const a of w.data.agents) for (const s of a.skillIds || []) ref('skills',s);
  }
  if (!wsIds.has(state.active)) fail('Active workspace does not exist.');
  return state;
}
