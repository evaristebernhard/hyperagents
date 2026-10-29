import { spawn } from 'node:child_process';
import net from 'node:net';

const MAX_OUTPUT_BYTES = 96 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 30_000;
const definition = { type:'function', function:{ name:'web_fetch', description:'Read one public HTTPS webpage through the local Moli headless browser and return bounded Markdown. Read-only: no clicks, form submits, cookies, screenshots, JavaScript evaluation, or writes. Private-network targets are blocked.', parameters:{type:'object',properties:{url:{type:'string',minLength:1,maxLength:2048}},required:['url'],additionalProperties:false}} };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const fail = message => { throw new Error(message); };
function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) fail('Invalid web URL.');
  let u; try { u = new URL(value); } catch { fail('Invalid web URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) fail('Web fetch requires a public HTTPS URL without credentials or fragments.');
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') fail('Private or local web targets are not allowed.');
  if (net.isIP(host)) {
    const parts = host.split('.').map(Number);
    const privateV4 = net.isIPv4(host) && (parts[0]===10 || parts[0]===127 || (parts[0]===172 && parts[1]>=16 && parts[1]<=31) || (parts[0]===192 && parts[1]===168) || (parts[0]===169 && parts[1]===254));
    const privateV6 = net.isIPv6(host) && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:'));
    if (privateV4 || privateV6) fail('Private or local web targets are not allowed.');
  }
  return u.href;
}
export function normalizeWebFetch(args) {
  if (!plain(args) || Object.keys(args).some(k=>k!=='url') || !Object.hasOwn(args,'url')) fail('Invalid web fetch arguments.');
  return {url:validateUrl(args.url)};
}
export function createMoliTools({enabled=[],moliPath=process.env.MOLI_PATH || '/home/ubuntu/.local/bin/moli'}={}) {
  const active = Array.isArray(enabled) && enabled.includes('Web Fetch');
  return { definitions: active ? [structuredClone(definition)] : [], async execute(name,args,signal) {
    if (!active || name !== 'web_fetch') fail('Web fetch is unavailable or disabled.');
    const {url}=normalizeWebFetch(args);
    if (signal?.aborted) fail('Web fetch cancelled.');
    return await runMoli(moliPath,url,signal);
  }, capabilities: [{name:'Web Fetch',available:active,reason:active?'Moli public HTTPS Markdown fetch is enabled.':'Enable Web Fetch in the thread tools.'}] };
}
function runMoli(binary,url,signal) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['fetch','--dump','markdown','--wait-until','done','--timeout',String(DEFAULT_TIMEOUT_MS),'--block-private-networks','--fail',url],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin',HOME:process.env.HOME || '/home/ubuntu',LANG:'C.UTF-8'}});
    let stdout=[],stderr=[],bytes=0,settled=false,timer;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(result);};
    const abort=()=>{child.kill('SIGKILL');finish(new Error('Web fetch cancelled.'));};
    child.stdout.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>MAX_OUTPUT_BYTES){child.kill('SIGKILL');finish(new Error('Web fetch result exceeded 96 KiB.'));return;}stdout.push(chunk);});
    child.stderr.on('data',chunk=>{if(Buffer.byteLength(Buffer.concat(stderr))+chunk.length<=8192)stderr.push(chunk);});
    child.on('error',error=>finish(new Error('Moli web fetch failed.')));
    child.on('close',(code,term)=>{if(settled)return;const text=Buffer.concat(stdout).toString('utf8');const detail=Buffer.concat(stderr).toString('utf8').trim();if(code!==0)finish(new Error(detail ? 'Moli web fetch failed: '+detail.slice(0,300) : 'Moli web fetch failed.'));else finish(null,{status:'ok',url,content:text,truncated:false,engine:'moli',bytes:Buffer.byteLength(text)});});
    timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Web fetch timed out.'));},MAX_TIMEOUT_MS);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
