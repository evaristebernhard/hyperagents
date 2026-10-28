import { loadLocalEnv } from './env.mjs';
loadLocalEnv();
process.env.APP_SERVE_DIST='1';
await import('../server/index.mjs');
