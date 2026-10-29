import { spawn } from 'node:child_process';
import net from 'node:net';
import { normalizeWebFetch } from './moli-tools.mjs';

const MAX_OUTPUT_BYTES = 128 * 1024;
const TIMEOUT_MS = 20_000;
const definition = {type:'function',function:{name:'web_semantic_tree',description:'Read a public HTTPS webpage semantic tree through local Moli. Read-only: no clicks, forms, cookies, screenshots, JavaScript evaluation, or writes.',parameters:{type:'object',properties:{url:{type:'string',minLength:1,maxLength:2048}},required:['url'],additionalProperties:false}}};
const isPrivate = host => {
 const h=host.toLowerCase().replace(/^\[|\]$/g,'');
 if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h==='metadata.google.internal')return true;
 if(!net.isIP(h))return false;
 if(net.isIPv4(h)){const p=h.split('.').map(Number);return p[0]===10||p[0]===127||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===169&&p[1]===254);}
 return h==='::1'||h==='::'||h.startsWith('fc')||h.startsWith('fd')||h.startsWith('fe8')||h.startsWith('fe9')||h.startsWith('fea')||h.startsWith('feb');
};
export function validateSemanticUrl(value){const {url}=normalizeWebFetch({url:value});const u=new URL(url);if(isPrivate(u.hostname))throw new Error('Private or local web targets are not allowed.');return u.href;}
export function createMoliSemanticTools({enabled=[],moliPath=process.env.MOLI_PATH||'/home/ubuntu/.local/bin/moli'}={}){
 const active=Array.isArray(enabled)&&enabled.includes('Web Semantic Tree');
 return {definitions:active?[structuredClone(definition)]:[],async execute(name,args,signal){if(!active||name!=='web_semantic_tree')throw Error('Semantic tree is unavailable or disabled.');const url=validateSemanticUrl(args?.url);return run(moliPath,url,signal);}};
}
function run(binary,url,signal){return new Promise((resolve,reject)=>{const child=spawn(binary,['fetch','--dump','semantic_tree_text','--wait-selector','body','--timeout',String(TIMEOUT_MS),'--block-private-networks','--fail',url],{shell:false,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin',HOME:process.env.HOME||'/home/ubuntu',LANG:'C.UTF-8'}});let out=[],err=[],bytes=0,done=false,timer;const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);e?reject(e):resolve(r);};const abort=()=>{child.kill('SIGKILL');finish(Error('Semantic tree request cancelled.'));};child.stdout.on('data',c=>{if(done)return;bytes+=c.length;if(bytes>MAX_OUTPUT_BYTES){child.kill('SIGKILL');finish(Error('Semantic tree result exceeded 128 KiB.'));}else out.push(c);});child.stderr.on('data',c=>{if(Buffer.concat(err).length<8192)err.push(c);});child.on('error',()=>finish(Error('Moli semantic tree failed to start.')));child.on('close',(code)=>{if(done)return;if(code!==0){const d=Buffer.concat(err).toString().trim();finish(Error(d?`Moli semantic tree failed: ${d.slice(0,250)}`:'Moli semantic tree failed.'));}else finish(null,{status:'ok',engine:'moli',url,semanticTreeText:Buffer.concat(out).toString('utf8'),truncated:false,bytes});});timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('Semantic tree request timed out.'));},TIMEOUT_MS);timer.unref?.();signal?.addEventListener('abort',abort,{once:true});});}
