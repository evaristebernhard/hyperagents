const plain = value => value!==null && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const clone = value => structuredClone(value);
const sources = new Set(['workspace','public-api','integration','shell','managed']);
const effects = new Set(['read-only','local-staged','approval-gated','mixed','orchestration']);
const fail = message => { throw new Error(message); };

// Supported JSON Schema subset for our authored adapters. An MCP adapter must
// validate foreign schemas with its SDK; this is not a general MCP validator.
export function validateToolArguments(schema, value, depth=0) {
  if(depth>10)fail('Tool arguments are too deeply nested.');
  if(depth===0 && (!plain(value) || Buffer.byteLength(JSON.stringify(value))>256000))fail('Tool arguments must be a bounded JSON object.');
  if(schema.anyOf && !schema.anyOf.some(s=>{try{validateToolArguments(s,value,depth+1);return true;}catch{return false;}}))fail('Tool arguments do not match an allowed shape.');
  if(schema.oneOf && schema.oneOf.filter(s=>{try{validateToolArguments(s,value,depth+1);return true;}catch{return false;}}).length!==1)fail('Tool arguments do not match exactly one shape.');
  if(schema.enum && !schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))fail('Unsupported tool argument value.');
  if(Object.hasOwn(schema,'const') && JSON.stringify(value)!==JSON.stringify(schema.const))fail('Unsupported tool argument constant.');
  const type=schema.type;
  if(Array.isArray(type)){if(!type.some(t=>{try{validateToolArguments({...schema,type:t},value,depth+1);return true;}catch{return false;}}))fail('Invalid tool argument type.');return;}
  if(type==='object') {
    if(!plain(value) || Object.keys(value).length>100)fail('Invalid tool object argument.');
    for(const key of schema.required||[])if(!Object.hasOwn(value,key))fail('Missing tool argument: '+key);
    for(const [key,item] of Object.entries(value)){
      if(['__proto__','prototype','constructor'].includes(key))fail('Invalid tool argument key.');
      const child=schema.properties?.[key];
      if(!child && schema.additionalProperties===false)fail('Unexpected tool argument: '+key);
      if(child)validateToolArguments(child,item,depth+1);
      else if(plain(schema.additionalProperties))validateToolArguments(schema.additionalProperties,item,depth+1);
    }
  } else if(type==='array'){
    if(!Array.isArray(value) || value.length<(schema.minItems??0) || value.length>(schema.maxItems??1000))fail('Invalid tool array argument.');
    if(schema.items)for(const item of value)validateToolArguments(schema.items,item,depth+1);
  } else if(type==='string'){
    if(typeof value!=='string' || value.length<(schema.minLength??0) || value.length>(schema.maxLength??100000) || (schema.pattern && !new RegExp(schema.pattern).test(value)))fail('Invalid tool text argument.');
  } else if(type==='integer' || type==='number'){
    if(typeof value!=='number' || !Number.isFinite(value) || (type==='integer' && !Number.isInteger(value)) || value<(schema.minimum??-Infinity) || value>(schema.maximum??Infinity))fail('Invalid tool numeric argument.');
  } else if(type==='boolean' && typeof value!=='boolean')fail('Invalid tool boolean argument.');
  else if(type==='null' && value!==null)fail('Invalid tool null argument.');
}

export function argumentShape(args) {
  if(!plain(args))return [];
  // Values, paths, commands, messages and tokens are deliberately NOT logged.
  return Object.entries(args).slice(0,40).map(([key,value])=>({field:key.slice(0,80),type:value===null?'null':Array.isArray(value)?'array':typeof value,...(typeof value==='string'?{characters:value.length}:Array.isArray(value)?{items:value.length}:{})}));
}
export function toolResultOutcome(result) {
  if(result?.isError===true || result?.error || result?.timedOut===true || result?.cancelled===true || (typeof result?.exitCode==='number' && result.exitCode!==0) || ['error','failed','timed_out','cancelled','denied'].includes(result?.status))return 'error';
  if(result?.status==='approval_required')return 'awaiting_approval';
  if(result?.status==='prepared')return 'prepared';
  return 'completed';
}
const catalogDefinition={type:'function',function:{name:'tool_catalog',description:'Discover tools authorized and bound for THIS run, including their source, effect and optional parameter schemas. Discovery never enables a tool, connects a service, approves an action, or starts a subagent. Do not call this when you already know the needed tool.',parameters:{type:'object',properties:{query:{type:'string',maxLength:200},source:{type:'string',enum:[...sources]},includeSchemas:{type:'boolean'},offset:{type:'integer',minimum:0,maximum:1000},limit:{type:'integer',minimum:1,maximum:20}},required:[],additionalProperties:false}}};

export function createToolRegistry(bindings=[], options={}) {
  const entries=new Map();
  for(const binding of bindings){
    if(!sources.has(binding.source) || !effects.has(binding.effect) || !Array.isArray(binding.definitions) || (binding.definitions.length && typeof binding.execute!=='function'))fail('Invalid tool adapter registration.');
    for(const definition of binding.definitions){
      const f=definition?.function;
      if(definition.type!=='function' || !f || !/^[_a-z]{1,80}$/.test(f.name) || f.name==='tool_catalog' || typeof f.description!=='string' || f.parameters?.type!=='object')fail('Invalid tool definition.');
      if(entries.has(f.name))fail('Duplicate tool registration: '+f.name);
      entries.set(f.name,{definition:clone(definition),source:binding.source,effect:binding.effect,execute:binding.execute});
    }
  }
  const hasCatalog=options.catalog!==false && entries.size>0;
  function metadata(name){const e=entries.get(name);return e?{name,source:e.source,effect:e.effect}:name==='tool_catalog'&&hasCatalog?{name,source:'managed',effect:'read-only'}:undefined;}
  function catalog(args){
    validateToolArguments(catalogDefinition.function.parameters,args);
    const query=(args.query||'').toLowerCase(),offset=args.offset||0,limit=args.limit||12;
    const all=[...entries.values()].filter(e=>(!args.source || e.source===args.source) && (!query || (e.definition.function.name+' '+e.definition.function.description).toLowerCase().includes(query)));
    const tools=all.slice(offset,offset+limit).map(e=>({name:e.definition.function.name,description:e.definition.function.description,source:e.source,effect:e.effect,...(args.includeSchemas?{parameters:clone(e.definition.function.parameters)}:{})}));
    return {scope:'authorized-tools-for-this-run',tools,total:all.length,nextOffset:offset+tools.length,hasMore:offset+tools.length<all.length,notice:'Only currently bound tools are shown. Adapter availability is not proof of upstream reachability. Approval-gated tools do not perform writes without their existing human approval flow.'};
  }
  return {
    definitions:()=>[...[...entries.values()].map(e=>clone(e.definition)),...(hasCatalog?[clone(catalogDefinition)]:[])],
    metadata,
    async execute(name,args,signal){
      if(signal?.aborted)fail('Tool execution cancelled.');
      if(name==='tool_catalog' && hasCatalog)return catalog(args);
      const entry=entries.get(name);if(!entry)fail('This tool is not enabled for the run.');
      validateToolArguments(entry.definition.function.parameters,args);
      const result=await entry.execute(name,clone(args),signal);
      if(signal?.aborted)fail('Tool execution cancelled.');
      return result;
    },
  };
}
