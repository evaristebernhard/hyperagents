import {captureIntegrationCredentials} from '../server/integrations.mjs';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { loadLocalEnv } from './env.mjs';
loadLocalEnv();
// Public development ingress for this replica; retain Host/Origin and CSRF checks.
process.env.APP_PUBLIC_ORIGIN = 'https://hyper.chayu123.me';
// Interpret only known options; never concatenate user arguments into a shell command.
const args=process.argv.slice(2);
let fixture=false, host='127.0.0.1',port=5173;
for (let i=0;i<args.length;i++) {
  const arg=args[i];
  if (arg==='--fixtures') { fixture=true; continue; }
  if (arg==='--strictPort' || arg==='--strict-port') continue;
  if (arg==='--host' || arg.startsWith('--host=')) {
    const inline=arg.startsWith('--host=')?arg.slice(7):undefined;
    host=inline ?? (args[i+1] && !args[i+1].startsWith('-')?args[++i]:'0.0.0.0');
    if (!/^(?:localhost|[a-zA-Z0-9.-]+|::1)$/.test(host)) throw Error('Invalid --host value.');
    continue;
  }
  if (arg==='--port' || arg.startsWith('--port=')) {
    const value=arg.startsWith('--port=')?arg.slice(7):args[++i];
    if (!/^\d+$/.test(value || '') || Number(value)<1 || Number(value)>65535) throw Error('Invalid --port value.');
    port=Number(value); continue;
  }
  throw Error(`Unsupported development option: ${arg}`);
}
const publicBind=!['127.0.0.1','localhost','::1'].includes(host);
if (!fixture && publicBind && !process.env.APP_PUBLIC_ORIGIN) throw Error('Public Vite binding requires an explicit APP_PUBLIC_ORIGIN and an initialized owner.');
process.env.VITE_STORAGE_MODE=fixture?'fixture':'server';
const integrationCredentials=captureIntegrationCredentials(process.env);
const ownerPassword=process.env.APP_OWNER_PASSWORD;
const deepseekApiKey=process.env.DEEPSEEK_API_KEY;
const openAlexApiKey=process.env.OPENALEX_API_KEY;
const publicUserAgent=process.env.PUBLIC_API_USER_AGENT || "Hyperagents-Replica/0.1";
delete process.env.OPENALEX_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.APP_OWNER_PASSWORD;
const browserHost=['0.0.0.0','::'].includes(host)?'127.0.0.1':host==='::1'?'[::1]':host;
process.env.APP_DEV_ORIGIN=`http://${browserHost}:${port}`;
const apiPort=Number(process.env.APP_PORT ?? 8787);
const apiHost=process.env.APP_HOST ?? '127.0.0.1';
const proxyHost=apiHost==='::1'?'[::1]':apiHost==='localhost'?'localhost':'127.0.0.1';
if (!Number.isSafeInteger(apiPort) || apiPort<1 || apiPort>65535) throw Error('Invalid APP_PORT.');
let app,vite,closing=false;
async function shutdown(code=0) {
  if (closing) return; closing=true;
  await Promise.allSettled([vite?.close(),app?.close()]); process.exitCode=code;
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>void shutdown());
try {
  if (!fixture) {
    app=await createApp({host:apiHost,port:apiPort,dataDir:process.env.APP_DATA_DIR ?? path.resolve('.data'),devOrigin:process.env.APP_DEV_ORIGIN,publicOrigin:process.env.APP_PUBLIC_ORIGIN,maxFileBytes:process.env.APP_MAX_FILE_BYTES,ownerPassword,integrationCredentials,deepseekApiKey,openAlexApiKey,publicUserAgent});
    await app.listen();
    if (publicBind) {
      const response=await fetch(`http://${proxyHost}:${apiPort}/api/session`);
      const session=await response.json();
      if (!response.ok || session.setupRequired) throw Error('Initialize the owner over loopback before exposing Vite.');
    }
  }
  const { createServer }=await import('vite');
  // Overrides the legacy config's public bind. The API validates original Host/Origin.
  const allowedHosts=['localhost','127.0.0.1','hyper.chayu123.me'];
  if (process.env.APP_PUBLIC_ORIGIN) allowedHosts.push(new URL(process.env.APP_PUBLIC_ORIGIN).hostname);
  vite=await createServer({server:{host,port,strictPort:true,allowedHosts,proxy:fixture?{}:{'/api':{target:`http://${proxyHost}:${apiPort}`,changeOrigin:false}}}});
  await vite.listen(); vite.printUrls();
} catch { console.error('Development startup failed. Check installed dependencies, available ports, origin configuration, Node 24+, and owner/bootstrap requirements.'); await shutdown(1); }
