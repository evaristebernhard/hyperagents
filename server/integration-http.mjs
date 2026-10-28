const ORIGINS=new Set(['https://api.github.com','https://slack.com','https://api.notion.com','https://api.airtable.com','https://api.linear.app','https://api.stripe.com','https://api.telegram.org','https://app.asana.com','https://gmail.googleapis.com','https://www.googleapis.com','https://calendar.googleapis.com','https://docs.googleapis.com','https://sheets.googleapis.com','https://oauth2.googleapis.com']);
export class IntegrationHttpError extends Error {constructor(message,status){super(message);this.name='IntegrationHttpError';this.status=status;}}
const abortable=(promise,signal)=>new Promise((resolve,reject)=>{if(signal.aborted)return reject(new IntegrationHttpError('Integration request cancelled.'));const abort=()=>reject(new IntegrationHttpError('Integration request cancelled.'));signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
/** Credential-bearing URLs/headers and upstream error bodies are never returned or logged. */
export function createIntegrationHttp(fetchImpl=globalThis.fetch) {
 return async function request(url,options={}) {
  let parsed;try{parsed=new URL(url);}catch{throw new IntegrationHttpError('Invalid integration endpoint.');}
  if(!ORIGINS.has(parsed.origin)||parsed.username||parsed.password||parsed.hash)throw new IntegrationHttpError('Unsupported integration endpoint.');
  const controller=new AbortController();let timedOut=false,reader;
  const cancel=()=>controller.abort();if(options.signal?.aborted)throw new IntegrationHttpError('Integration request cancelled.');options.signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},15000);timer.unref();
  try {
   let body;const headers={Accept:'application/json',...options.headers};
   if(options.form!==undefined){headers['Content-Type']='application/x-www-form-urlencoded';body=new URLSearchParams(options.form).toString();}
   else if(options.body!==undefined){if(!options.body||typeof options.body!=='object'||Array.isArray(options.body))throw new IntegrationHttpError('Integration JSON body must be an object.');headers['Content-Type']='application/json';body=JSON.stringify(options.body);}
   if(body && Buffer.byteLength(body)>100000)throw new IntegrationHttpError('Integration request body is too large.');
   const response=await abortable(fetchImpl(parsed.href,{method:options.method||'GET',headers,body,signal:controller.signal,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer'}),controller.signal);
   if(response.redirected||(response.url&&new URL(response.url).origin!==parsed.origin))throw new IntegrationHttpError('Integration redirects are not permitted.');
   if(!response.ok){void response.body?.cancel().catch(()=>{});throw new IntegrationHttpError('Integration service returned HTTP '+response.status+'.',response.status);}
   if(response.status===204)return {};
   if(Number(response.headers.get('content-length')||0)>1024*1024)throw new IntegrationHttpError('Integration response exceeds the size limit.');
   if(!response.body)throw new IntegrationHttpError('Integration service returned no response body.');
   reader=response.body.getReader();const chunks=[];let size=0;
   while(true){const {done,value}=await abortable(reader.read(),controller.signal);if(value){size+=value.byteLength;if(size>1024*1024)throw new IntegrationHttpError('Integration response exceeds the size limit.');chunks.push(value);}if(done)break;}
   let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new IntegrationHttpError('Integration service returned invalid JSON.');}
   return data;
  }catch(e){if(timedOut)throw new IntegrationHttpError('Integration request timed out.');if(options.signal?.aborted)throw new IntegrationHttpError('Integration request cancelled.');if(e instanceof IntegrationHttpError)throw e;throw new IntegrationHttpError('Integration request failed; check server credentials and service access.');}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
 };
}
export function validateArguments(schema,value,depth=0){
 if(depth>7)throw Error('Integration arguments are too deeply nested.');
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Integration arguments must be an object.');
  if(Object.keys(value).length>100)throw Error('Too many integration argument fields.');
  for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw Error('Missing integration argument: '+key);
  for(const [key,item]of Object.entries(value)){
   if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid integration argument key.');
   const child=schema.properties?.[key];if(!child&&schema.additionalProperties===false)throw Error('Unexpected integration argument: '+key);
   if(child)validateArguments(child,item,depth+1);else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')validateArguments(schema.additionalProperties,item,depth+1);
  }
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length>(schema.maxItems??1000)||value.length<(schema.minItems??0))throw Error('Invalid integration array argument.');
  if(schema.items)for(const item of value)validateArguments(schema.items,item,depth+1);
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length>(schema.maxLength??30000)||value.length<(schema.minLength??0)||(schema.pattern&&!new RegExp(schema.pattern).test(value)))throw Error('Invalid integration text argument.');
 }else if(schema.type==='integer'||schema.type==='number'){
  if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value))||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))throw Error('Invalid integration numeric argument.');
 }else if(schema.type==='boolean'&&typeof value!=='boolean')throw Error('Invalid integration boolean argument.');
 if(schema.enum&&!schema.enum.includes(value))throw Error('Unsupported integration argument value.');
 if(Buffer.byteLength(JSON.stringify(value)??'')>50000)throw Error('Integration arguments are too large.');
}
