import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync, realpathSync, lstatSync, constants, createReadStream } from 'node:fs';
import { open, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApiError, emptyState, validateState } from './validation.mjs';
import { prepareLegacy } from './legacy.mjs';
import { createLlm } from './llm.mjs';
const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const loopback = host => ['127.0.0.1','localhost','::1','[::1]'].includes(host);
const now = () => new Date().toISOString();
const err = (status,message,code) => { throw new ApiError(status,message,code); };
function origin(value) {
  try { const u = new URL(value); if (!['http:','https:'].includes(u.protocol) || u.origin !== value || u.username || u.password) throw Error(); return u; }
  catch { throw Error('Origins must be exact http(s) origins without a path.'); }
}
function privateDirectory(dir) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw Error('Data directories must be real directories.');
  chmodSync(dir,0o700); return realpathSync(dir);
}
function checkedNumber(value,fallback,min,max) { const n=value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(n) || n<min || n>max) throw Error('Invalid numeric server configuration.'); return n; }

/** Create an isolated service; no socket is opened and no environment credentials are read here.
 * Tests pass a temporary dataDir. close() closes active connections and SQLite. */
export async function createApp(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = checkedNumber(options.port,8787,0,65535);
  const maxFileBytes = checkedNumber(options.maxFileBytes,20*1024*1024,1,100*1024*1024);
  const maxStateBytes = 10*1024*1024;
  const dev = origin(options.devOrigin ?? 'http://127.0.0.1:5173');
  const publicOrigin = options.publicOrigin ? origin(options.publicOrigin) : undefined;
  const allowed = new Set([dev.origin]);
  if (['127.0.0.1','localhost'].includes(dev.hostname)) {
    const alternate = new URL(dev); alternate.hostname=dev.hostname==='localhost'?'127.0.0.1':'localhost'; allowed.add(alternate.origin);
  }
  if (publicOrigin) allowed.add(publicOrigin.origin);
  const dataDir = privateDirectory(options.dataDir ?? path.resolve('.data'));
  const uploadsDir = privateDirectory(path.join(dataDir,'uploads'));
  const dbPath = path.join(dataDir,'workspace.sqlite');
  try { if (lstatSync(dbPath).isSymbolicLink()) throw Error('Database cannot be a symbolic link.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const db = new DatabaseSync(dbPath);
  // Refuse unknown/future databases before schema creation or journal changes.
  const existingTables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (existingTables.length) {
    if (!existingTables.some(row=>row.name==='schema_version')) { db.close(); throw Error('Unrecognized existing database.'); }
    const versions=db.prepare('SELECT version FROM schema_version').all();
    if (versions.length!==1 || versions[0].version!==1) { db.close(); throw Error('Unsupported database schema version.'); }
  }
  chmodSync(dbPath,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_version VALUES (1);
    CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, snapshot TEXT NOT NULL);`);
  const schemaVersions=db.prepare('SELECT version FROM schema_version').all();
  if (schemaVersions.some(row=>row.version!==1)) { db.close(); throw Error('Unsupported database schema version.'); }
  const initial=emptyState();
  db.prepare('INSERT OR IGNORE INTO workspace VALUES (1,?,0)').run(JSON.stringify(initial));
  const owner = () => db.prepare('SELECT * FROM owner WHERE id=1').get();
  async function passwordDigest(password,salt) { return (await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024})).toString('hex'); }
  function passwordValid(password) { if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) err(422,'Password must be 12–1024 characters (at most 1024 bytes).','PASSWORD'); }
  async function setOwner(password) { passwordValid(password); const salt=random(); const digest=await passwordDigest(password,salt); const result=db.prepare('INSERT OR IGNORE INTO owner VALUES (1,?,?)').run(salt,digest); if (!result.changes) err(409,'Owner already exists.'); }
  try {
    if (!owner() && options.ownerPassword !== undefined) await setOwner(options.ownerPassword);
    if (!loopback(host) && !owner()) throw Error('External binding requires an existing owner or APP_OWNER_PASSWORD bootstrap.');
  } catch(e) { db.close(); throw e; }
  const load = () => { const row=db.prepare('SELECT * FROM workspace WHERE id=1').get(); return {state:JSON.parse(row.state),revision:row.revision}; };
  const meta = row => row && ({id:row.id,workspaceId:row.workspace_id,name:row.name,size:row.size,mimeType:row.mime_type,createdAt:row.created_at});
  const findFile = (id,workspaceId) => meta(db.prepare('SELECT * FROM files WHERE id=? AND workspace_id=?').get(id,workspaceId));
  // Only authenticated chat execution can read saved, workspace-owned UTF-8 text.
  const llm=createLlm({apiKey:options.deepseekApiKey,fetchImpl:options.llmFetch,load,readAttachment:async(f,workspaceId)=> {
    if (!/^file-[a-f0-9-]{36}$/.test(f.id)) return null;
    const stored=findFile(f.id,workspaceId);
    if (!stored || ['name','size','mimeType','createdAt','workspaceId'].some(k=>stored[k]!==f[k]) || stored.size>16384) return null;
    if (!/^(?:text\/[a-z0-9!#$&^_.+-]+|application\/(?:json|ld\+json|xml|javascript|x-yaml|yaml))(?:;|$)/i.test(stored.mimeType)) return null;
    let handle;
    try {
      handle=await open(path.join(uploadsDir,stored.id),constants.O_RDONLY|constants.O_NOFOLLOW);
      const st=await handle.stat();if(!st.isFile() || st.size!==stored.size)return null;
      const buffer=Buffer.alloc(stored.size+1);
      const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
      if(bytesRead!==stored.size)return null;
      const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead));
      return text.includes('\u0000')?null:text;
    } catch {return null;} finally {if(handle)await handle.close().catch(()=>{});}
  }});
  const workspace = id => { const w=load().state.workspaces.find(w=>w.id===id); if (!w) err(422,'Invalid workspace.'); return w; };
  const commit = (state, revision) => {
    if (!Number.isSafeInteger(revision) || revision<0) err(400,'A valid revision is required.');
    const data=JSON.stringify(state); if (Buffer.byteLength(data)>maxStateBytes) err(413,'Workspace is too large.');
    const result=db.prepare('UPDATE workspace SET state=?,revision=revision+1 WHERE id=1 AND revision=?').run(data,revision);
    if (!result.changes) err(409,'Workspace changed. Reload before saving.','CONFLICT');
    return revision+1;
  };
  const limits = new Map();
  const rateWindow = 15*60*1000;
  function rate(key,max) {
    const time=Date.now();
    for (const [k,v] of limits) if (v.until<=time) limits.delete(k);
    const record=limits.get(key) || {until:time+rateWindow,count:0}; record.count++; limits.set(key,record);
    if (record.count>max || limits.size>1000) err(429,'Too many attempts. Try again later.','RATE_LIMIT');
  }
  let authWork=0;
  async function authTask(fn) { if (authWork>=4) err(429,'Too many attempts. Try again later.','RATE_LIMIT'); authWork++; try { return await fn(); } finally { authWork--; } }
  const sessionHours=checkedNumber(options.sessionHours,12,1,24);
  function send(res,status,value) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
  function createSession(res,secure) {
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    // Single owner, bounded concurrent sessions. Password login invalidates oldest sessions beyond 20.
    db.exec('DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 19)');
    const token=random(), csrf=random(), seconds=sessionHours*3600;
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),csrf,Date.now()+seconds*1000);
    res.setHeader('Set-Cookie',`hyperagents_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure?'; Secure':''}`);
    return csrf;
  }
  function getSession(req) {
    const cookies=(req.headers.cookie || '').split(';').map(c=>c.trim()).filter(c=>c.startsWith('hyperagents_session='));
    if (cookies.length!==1) return;
    const token=cookies[0].slice('hyperagents_session='.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    return db.prepare('SELECT * FROM sessions WHERE digest=? AND expires>?').get(hash(token),Date.now());
  }
  async function bytes(req,max) {
    const length=req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length)>max)) err(413,'Request is too large.');
    const chunks=[]; let size=0;
    for await (const chunk of req.iterator({destroyOnReturn:false})) { size+=chunk.length; if (size>max) err(413,'Request is too large.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function body(req,max=maxStateBytes) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) err(400,'Content-Type must be application/json.');
    try { return JSON.parse((await bytes(req,max)).toString('utf8')); } catch(e) { if (e instanceof ApiError) throw e; err(400,'Invalid JSON.'); }
  }
  function exactBody(value,keys) { if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) err(400,'Invalid request fields.'); }
  function shareMeta(row) { return {id:row.id,token:row.token,workspaceId:row.workspace_id,threadId:row.thread_id,createdAt:row.created_at,...(row.revoked_at?{revokedAt:row.revoked_at}:{})}; }
  const server=http.createServer(async (req,res)=> {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    try {
      const hosts=new Set([...allowed].map(o=>new URL(o).host));
      const boundPort=server.address()?.port ?? port;
      for (const h of ['127.0.0.1','localhost','[::1]']) hosts.add(`${h}:${boundPort}`);
      const hostCount=req.rawHeaders.filter((_,i)=>i%2===0 && req.rawHeaders[i].toLowerCase()==='host').length;
      if (hostCount!==1 || !req.headers.host || !hosts.has(req.headers.host)) err(403,'Untrusted Host.','HOST');
      const url=new URL(req.url,'http://localhost');
      if (!req.url.startsWith('/') || req.url.startsWith('//')) err(400,'Invalid request target.');
      const route=url.pathname, method=req.method;
      const requestOrigin=req.headers.origin;
      const allowedOrigin=new Set(allowed);
      for (const h of ['127.0.0.1','localhost','[::1]']) allowedOrigin.add(`http://${h}:${boundPort}`);
      if (requestOrigin && !allowedOrigin.has(requestOrigin)) err(403,'Untrusted Origin.','ORIGIN');
      const mutation=!['GET','HEAD'].includes(method);
      if (mutation && (!requestOrigin || !allowedOrigin.has(requestOrigin))) err(403,'An allowed Origin is required.','ORIGIN');
      if (req.headers['sec-fetch-site']==='cross-site') err(403,'Cross-site requests are not allowed.','ORIGIN');
      const secure = requestOrigin ? new URL(requestOrigin).protocol==='https:' : publicOrigin?.protocol==='https:' && req.headers.host===publicOrigin.host;
      if (route==='/api/status' && method==='GET') return send(res,200,{ok:true,version:1});
      if (route==='/api/session' && method==='GET') { const session=getSession(req); return send(res,200,{authenticated:!!session,setupRequired:!owner(),...(session?{csrfToken:session.csrf}:{})}); }
      if (['/api/setup','/api/login'].includes(route) && method==='POST') {
        rate(`auth:${req.socket.remoteAddress}`,10); rate('auth:global',30);
        if (route==='/api/setup' && (!loopback(new URL(requestOrigin).hostname) || !loopback(new URL('http://'+req.headers.host).hostname) || !loopback(req.socket.remoteAddress?.replace(/^::ffff:/,'')))) err(403,'Setup is only allowed from loopback.');
        const b=await body(req,4096); exactBody(b,['password']); passwordValid(b.password);
        return await authTask(async()=> {
          if (route==='/api/setup') await setOwner(b.password);
          else {
            const o=owner(); const digest=await passwordDigest(b.password,o?.salt || 'unconfigured-owner');
            if (!o || !timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(o.digest,'hex'))) err(401,'Invalid password.');
          }
          return send(res,200,{authenticated:true,setupRequired:false,csrfToken:createSession(res,secure)});
        });
      }
      const publicMatch=route.match(/^\/api\/public\/shares\/([A-Za-z0-9_-]{43})$/);
      if (publicMatch && method==='GET') {
        const row=db.prepare('SELECT snapshot FROM shares WHERE token=? AND revoked_at IS NULL').get(publicMatch[1]);
        if (!row) err(404,'Share not found.'); return send(res,200,JSON.parse(row.snapshot));
      }
      if (!route.startsWith('/api/')) {
        if (options.distDir && ['GET','HEAD'].includes(method)) return await serveDist(req,res,route,options.distDir);
        err(404,'Not found.');
      }
      if (route.startsWith('/api/public/shares/') && method==='GET') err(404,'Share not found.');
      const session=getSession(req);
      if (!session) err(401,'Sign in required.','UNAUTHENTICATED');
      if (mutation && (typeof req.headers['x-csrf-token']!=='string' || req.headers['x-csrf-token']!==session.csrf)) err(403,'Invalid CSRF token.','CSRF');
      if (route==='/api/logout' && method==='POST') {
        db.prepare('DELETE FROM sessions WHERE digest=?').run(session.digest);
        res.setHeader('Set-Cookie',`hyperagents_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure?'; Secure':''}`);
        return send(res,200,{authenticated:false,setupRequired:false});
      }
      if (route==='/api/llm/config' && method==='GET') return send(res,200,llm.config());
      if (route==='/api/llm/chat' && method==='POST') return await llm.chat(req,res,await body(req,4096));
      if (route==='/api/state' && method==='GET') return send(res,200,load());
      if (route==='/api/state' && method==='PUT') {
        const match=req.headers['if-match'];
        if (typeof match!=='string' || !/^(?:\d+|"\d+")$/.test(match)) err(400,'If-Match revision is required.');
        const revision=Number(match.replaceAll('"',''));
        if (revision!==load().revision) err(409,'Workspace changed. Reload before saving.','CONFLICT');
        const payload=await body(req);
        const state=validateState(payload && Object.keys(payload).length===1 && Object.hasOwn(payload,'state') ? payload.state : payload,findFile);
        return send(res,200,{revision:commit(state,revision)});
      }
      if (route==='/api/migrate/preview' && method==='POST') {
        const b=await body(req);exactBody(b,['state']);
        const candidate=prepareLegacy(b.state,findFile);
        if(load().state.workspaces.length+candidate.state.workspaces.length>50)err(422,'Import would exceed the 50-workspace limit. Import a smaller explicit backup.');
        return send(res,200,{warnings:candidate.warnings,workspaceCount:candidate.state.workspaces.length});
      }
      if (route==='/api/migrate' && method==='POST') {
        const b=await body(req); exactBody(b,['state','revision']);
        const current=load(); if (b.revision!==current.revision) err(409,'Workspace changed. Reload before importing.','CONFLICT');
        const imported=prepareLegacy(b.state,findFile);
        for (const w of imported.state.workspaces) {
          const newId='workspace-'+randomUUID();
          const copy=structuredClone(w); copy.id=newId; copy.name=(w.name.slice(0,175)+' (imported)');
          current.state.workspaces.push(copy);
        }
        validateState(current.state,findFile);
        return send(res,200,{state:current.state,revision:commit(current.state,b.revision),warnings:imported.warnings});
      }
      if (route==='/api/files' && method==='POST') {
        const workspaceId=url.searchParams.get('workspaceId'); workspace(workspaceId);
        let name; try { name=decodeURIComponent(req.headers['x-file-name']); } catch { err(422,'Invalid filename.'); }
        if (typeof req.headers['x-file-name']!=='string' || !name || Buffer.byteLength(name)>255 || /[\x00-\x1f\x7f/\\]/.test(name) || ['.','..'].includes(name)) err(422,'Invalid filename.');
        const mimeType=(req.headers['content-type'] || 'application/octet-stream').toLowerCase();
        if (mimeType.length>200 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(mimeType)) err(422,'Invalid MIME type.');
        const length=req.headers['content-length']; if (length && (!/^\d+$/.test(length) || Number(length)>maxFileBytes)) err(413,'File is too large.');
        const id='file-'+randomUUID(), temp=path.join(uploadsDir,'.tmp-'+randomUUID()), target=path.join(uploadsDir,id);
        let handle; let size=0; let moved=false;
        try {
          handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
          for await (const chunk of req.iterator({destroyOnReturn:false})) { size+=chunk.length; if (size>maxFileBytes) err(413,'File is too large.'); await handle.writeFile(chunk); }
          await handle.sync(); await handle.close(); handle=undefined;
          // A concurrent state update may have removed the workspace during streaming.
          workspace(workspaceId);
          await rename(temp,target); moved=true;
          const createdAt=now(); db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?)').run(id,workspaceId,name,size,mimeType,createdAt);
          return send(res,201,{file:{id,name,size,mimeType,createdAt,workspaceId}});
        } catch(e) { if (handle) await handle.close().catch(()=>{}); await unlink(moved?target:temp).catch(()=>{}); throw e; }
      }
      const fileMatch=route.match(/^\/api\/files\/(file-[a-f0-9-]{36})$/);
      if (fileMatch && method==='GET') {
        const workspaceId=url.searchParams.get('workspaceId'); workspace(workspaceId);
        const f=findFile(fileMatch[1],workspaceId); if (!f) err(404,'File not found.');
        let handle;
        try { handle=await open(path.join(uploadsDir,f.id),constants.O_RDONLY|constants.O_NOFOLLOW); const st=await handle.stat(); if (!st.isFile() || st.size!==f.size) { await handle.close(); err(404,'File not found.'); } }
        catch(e) { if (e instanceof ApiError) throw e; err(404,'File not found.'); }
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':f.size,'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`,'Content-Security-Policy':"default-src 'none'; sandbox"});
        await pipeline(handle.createReadStream(),res); return;
      }
      if (route==='/api/shares' && method==='GET') {
        const workspaceId=url.searchParams.get('workspaceId'),threadId=url.searchParams.get('threadId');
        const w=workspace(workspaceId); if (!w.data.threads.some(t=>t.id===threadId)) err(404,'Thread not found.');
        return send(res,200,{shares:db.prepare('SELECT * FROM shares WHERE workspace_id=? AND thread_id=? ORDER BY created_at').all(workspaceId,threadId).map(shareMeta)});
      }
      if (route==='/api/shares' && method==='POST') {
        const b=await body(req,64*1024); exactBody(b,['workspaceId','threadId','artifactIds']);
        const w=workspace(b.workspaceId),thread=w.data.threads.find(t=>t.id===b.threadId); if (!thread) err(404,'Thread not found.');
        const ids=b.artifactIds ?? []; if (!Array.isArray(ids) || ids.length>100 || ids.some(id=>typeof id!=='string') || new Set(ids).size!==ids.length) err(422,'Invalid artifact selection.');
        const artifacts=ids.map(id=> { const a=w.data.artifacts.find(a=>a.id===id && a.threadId===thread.id); if (!a) err(422,'Artifact is not attached to this thread.'); return {id:a.id,title:a.title,kind:a.kind,content:a.content}; });
        const createdAt=now(),id='share-'+randomUUID(),token=random();
        const snapshot={title:thread.title,createdAt,messages:(thread.messages || []).map(m=>({role:m.role,text:m.text,...(m.createdAt?{createdAt:m.createdAt}:{}),...(m.context?.attachments?.length?{attachments:m.context.attachments.map(f=>({name:f.name}))}:{})})),artifacts};
        db.prepare('INSERT INTO shares VALUES (?,?,?,?,?,?,?)').run(id,token,w.id,thread.id,createdAt,null,JSON.stringify(snapshot));
        return send(res,201,{share:{id,token,workspaceId:w.id,threadId:thread.id,createdAt}});
      }
      const shareMatch=route.match(/^\/api\/shares\/(share-[a-f0-9-]{36})$/);
      if (shareMatch && method==='DELETE') {
        const result=db.prepare('UPDATE shares SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(now(),shareMatch[1]);
        if (!result.changes) err(404,'Share not found.'); return send(res,200,{revoked:true});
      }
      err(404,'Not found.');
    } catch(e) {
      if (res.headersSent) { res.destroy(); return; }
      const status=e instanceof ApiError?e.status:500;
      if (status===429) res.setHeader('Retry-After',req.url?.startsWith('/api/llm/')?'60':'900');
      if (!req.complete) {
        res.setHeader('Connection','close');
        res.once('finish',()=>req.destroy());
        req.resume();
      }
      send(res,status,{error:status===500?'Internal server error.':e.message,...(e instanceof ApiError && e.code?{code:e.code}:{})});
    }
  });
  server.requestTimeout=60000; server.headersTimeout=15000; server.keepAliveTimeout=5000; server.maxRequestsPerSocket=1000;
  return {server, async listen() { await new Promise((resolve,reject)=>{server.once('error',reject); server.listen(port,host,()=>{server.off('error',reject);resolve();});}); return server.address(); }, async close() { await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}); db.close(); }};
}
async function serveDist(req,res,route,distDir) {
  const root=realpathSync(distDir);
  let decoded; try { decoded=decodeURIComponent(route); } catch { err(400,'Invalid path.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(x=>x==='..' || x.startsWith('.'))) err(404,'Not found.');
  let candidate=path.resolve(root,'.'+decoded);
  if (!candidate.startsWith(root+path.sep) && candidate!==root) err(404,'Not found.');
  let resolved;
  try { resolved=await stat(candidate); } catch { /* SPA fallback, not API paths */ }
  if (!resolved?.isFile()) candidate=path.join(root,'index.html');
  const real=realpathSync(candidate); if (!real.startsWith(root+path.sep)) err(404,'Not found.');
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2'};
  res.setHeader('Content-Type',types[path.extname(real)] || 'application/octet-stream');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (req.method==='HEAD') return res.end();
  await pipeline(createReadStream(real),res);
}
