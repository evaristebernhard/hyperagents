import { createApp } from './app.mjs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadLocalEnv } from '../scripts/env.mjs';
loadLocalEnv();
const ownerPassword=process.env.APP_OWNER_PASSWORD;
const deepseekApiKey=process.env.DEEPSEEK_API_KEY;
const openAlexApiKey=process.env.OPENALEX_API_KEY;
const publicUserAgent=process.env.PUBLIC_API_USER_AGENT || "Hyperagents-Replica/0.1";
delete process.env.OPENALEX_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
// Never pass the bootstrap secret to children or log it.
delete process.env.APP_OWNER_PASSWORD;
try {
  const app=await createApp({
    host:process.env.APP_HOST ?? '127.0.0.1', port:process.env.APP_PORT ?? 8787,
    dataDir:process.env.APP_DATA_DIR ?? path.resolve('.data'),
    devOrigin:process.env.APP_DEV_ORIGIN,
    publicOrigin:process.env.APP_PUBLIC_ORIGIN,
    maxFileBytes:process.env.APP_MAX_FILE_BYTES,
    ownerPassword,
    deepseekApiKey,openAlexApiKey,publicUserAgent,
    distDir:process.env.APP_SERVE_DIST==='1' && existsSync('dist/index.html') ? path.resolve('dist') : undefined,
  });
  const address=await app.listen();
  console.log(`Local API listening on ${address.address}:${address.port}`);
  let closing=false;
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,async()=> { if (closing) return; closing=true; await app.close(); process.exit(0); });
} catch { console.error('API startup failed. Check Node 24+, data-directory permissions, origin/port configuration, and owner/bootstrap requirements.'); process.exitCode=1; }
