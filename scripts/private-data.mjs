import path from 'node:path';
import { realpathSync } from 'node:fs';
const canonical = filename => {
  const absolute=path.resolve(filename);
  try { return realpathSync.native(absolute); } catch { return absolute; }
};
const fold = value => process.platform==='win32' ? value.toLowerCase() : value;
const inside = (filename,root) => {
  const relative=path.relative(fold(canonical(root)),fold(canonical(filename)));
  return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));
};
export function isPrivateDataRequest(rawUrl,{root=process.cwd(),dataDir=process.env.APP_DATA_DIR || path.resolve(root,'.data')}={}) {
  let pathname=String(rawUrl || '').split('?')[0].split('#')[0];
  try {
    for(let i=0;i<3;i++) { const decoded=decodeURIComponent(pathname); if(decoded===pathname) break; pathname=decoded; }
  } catch { return true; }
  pathname=pathname.replaceAll('\\','/');
  if(pathname.includes('\0') || /(^|\/)\.data(?:\/|$)/i.test(pathname)) return true;
  if(/\.(?:sqlite3?|db)(?:[-.][^/]*)?$/i.test(pathname)) return true;
  let candidates;
  if(pathname.startsWith('/@fs/')) {
    const target=pathname.slice(4);
    candidates=[path.resolve(/^\/[A-Za-z]:\//.test(target)?target.slice(1):target)];
  } else {
    const target=pathname.replace(/^\/+/, '');
    candidates=[path.resolve(root,target),path.resolve(root,'public',target)];
  }
  const protectedRoots=[path.resolve(root,'.data'),path.resolve(dataDir)];
  return candidates.some(filename=>protectedRoots.some(dir=>inside(filename,dir)));
}
export default function privateDataPlugin() {
  let root=process.cwd();
  return {
    name:'deny-private-local-data',
    enforce:'pre',
    configResolved(config) { root=config.root; },
    configureServer(server) {
      server.middlewares.use((req,res,next)=>{
        if(!isPrivateDataRequest(req.url,{root,dataDir:process.env.APP_DATA_DIR || path.resolve(root,'.data')})) return next();
        res.statusCode=403;
        res.setHeader('Content-Type','text/plain; charset=utf-8');
        res.setHeader('Cache-Control','no-store');
        res.end('Private local data cannot be served by the development server.');
      });
    },
  };
}
export const privateFsDeny=['.env','.env.*','*.{crt,pem}','**/.git/**','**/.data/**','**/*.sqlite*','**/*.db','**/*.db-*'];
