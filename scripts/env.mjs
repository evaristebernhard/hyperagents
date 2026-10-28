import { existsSync } from 'node:fs';
export function loadLocalEnv() {
  if (process.env.APP_ENV_FILE === 'none') return;
  const file = process.env.APP_ENV_FILE || '.env';
  if (existsSync(file)) process.loadEnvFile(file);
  else if (process.env.APP_ENV_FILE) throw Error('Configured environment file does not exist.');
}
