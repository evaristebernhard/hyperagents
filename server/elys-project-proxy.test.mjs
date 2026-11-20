import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from './app.mjs';
import {emptyState} from './validation.mjs';

const project=(id,extra={})=>({id,name:id,description:'Isolated proxy fixture',goal:'Keep app scoped',application:'elys',...extra});
const prefix=(projectId='elys-one',userId='user-lin',workspaceId='personal')=>`/api/project-apps/elys/${workspaceId}/${projectId}/${userId}/`;
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'hyperagents-elys-proxy-'));
  const calls=[],compressed=gzipSync(Buffer.from([0,255,129,40,19]));
  let streamEnded=false;
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(part);
    const record={url:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString()};calls.push(record);
    if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><script src="/assets/app.js"></script><link HREF = "/assets/app.css"><a href="//example.org/external">external</a><form action="/api/form"></form>');}
    if(req.url==='/cookies'){
      res.writeHead(200,{'Set-Cookie':['elys_session=fixture-only; HttpOnly; SameSite=Lax; Path=/; Domain=127.0.0.1','preference=compact; Path=/nested; Max-Age=30']});return res.end('cookies');
    }
    if(req.url==='/api/echo?version=2') {res.writeHead(201,{'Content-Type':'application/json'});return res.end(JSON.stringify(record));}
    if(req.url==='/binary'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Encoding':'gzip'});return res.end(compressed);}
    if(req.url==='/stream'){
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: first\n\n');
      setTimeout(()=>{streamEnded=true;res.end('data: final\n\n');},100);return;
    }
    if(req.url==='/nested/redirect'){res.writeHead(302,{Location:'next?complete=1#done'});return res.end();}
    if(req.url==='/external-redirect'){res.writeHead(302,{Location:'https://outside.example/'});return res.end();}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(record));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const upstreamOrigin=`http://127.0.0.1:${upstream.address().port}`;
  const app=await createApp({dataDir:directory,port:0,elysTargets:Object.fromEntries(['user-lin','user-man','user-shan'].map(id=>[id,upstreamOrigin]))});
  const origin=`http://127.0.0.1:${(await app.listen()).port}`;let cookie,csrf;
  t.after(async()=>{await app.close();await new Promise(resolve=>upstream.close(resolve));upstream.closeAllConnections();await rm(directory,{recursive:true,force:true});});
  const request=(route,options={})=>fetch(origin+route,{redirect:'manual',...options,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...options.headers}});
  const setup=async()=>{
    const response=await request('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'isolated-elys-proxy-password'})});assert.equal(response.status,200);
    cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrfToken;
    const state=emptyState();state.workspaces[0].data.projects.push(project('elys-one'),project('elys-two'),project('archived',{archived:true}),{id:'ordinary',name:'ordinary',description:'',goal:''});
    const foreign=structuredClone(state.workspaces[0]);foreign.id='other';foreign.name='Other';foreign.data.projects=[project('foreign-only')];state.workspaces.push(foreign);
    const saved=await request('/api/state',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':'0'},body:JSON.stringify({state})});assert.equal(saved.status,200,await saved.text());
  };
  return{request,setup,calls,compressed,origin,upstreamOrigin,get cookie(){return cookie;},get streamEnded(){return streamEnded;}};
}

test('Elys project proxy checks owner, Origin, CSRF and active project attachment before any upstream call',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(prefix())).status,401);
  await f.setup();
  for(const[route,options,status]of[
    [prefix(),{method:'POST',headers:{'X-CSRF-Token':'wrong'}},403],
    [prefix(),{headers:{Origin:'https://foreign.example'}},403],
    [prefix('missing'),{},404],[prefix('foreign-only'),{},404],[prefix('elys-one','user-lin','other'),{},404],
    [prefix('archived'),{},404],[prefix('ordinary'),{},404],[prefix('elys-one','unknown'),{},400],
    [prefix()+'/127.0.0.1:9/escape',{},400],[prefix()+'%2fescape',{},400],[prefix()+'%5cescape',{},400],
  ])assert.equal((await f.request(route,options)).status,status,route);
  assert.equal(f.calls.length,0);
});

test('Elys iframe HTML uses the project asset/form prefix and SAMEORIGIN response policy',async t=>{
  const f=await fixture(t);await f.setup();
  const response=await f.request(prefix());const html=await response.text();
  assert.equal(response.status,200);assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.equal(response.headers.get('content-security-policy'),"frame-ancestors 'self'");
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.ok(html.includes(`src="${prefix()}assets/app.js"`));assert.ok(html.includes(`HREF = "${prefix()}assets/app.css"`));
  assert.ok(html.includes(`action="${prefix()}api/form"`));assert.ok(html.includes('href="//example.org/external"'));
  assert.equal(f.calls[0].url,'/');
});

test('Elys cookies remain isolated by workspace/project/identity and never forward owner auth',async t=>{
  const f=await fixture(t);await f.setup();
  const response=await f.request(prefix()+'cookies');await response.text();
  const cookies=response.headers.getSetCookie();assert.equal(cookies.length,2);
  for(const value of cookies){assert.match(value,/^ep_[a-f0-9]{20}_/);assert.ok(value.includes(`Path=${prefix()}`));assert.doesNotMatch(value,/Domain=/i);}
  const scoped=cookies.map(value=>value.split(';')[0]).join('; ');
  const echo=await f.request(prefix()+'echo',{headers:{Cookie:f.cookie+'; unrelated=private; '+scoped,Authorization:'Bearer owner-private-token','X-CSRF-Token':'unused-on-get'}});
  const record=await echo.json();assert.equal(record.headers.cookie,'elys_session=fixture-only; preference=compact');
  assert.equal(record.headers.authorization,undefined);assert.equal(record.headers['x-csrf-token'],undefined);
  assert.equal(record.headers.host,new URL(f.upstreamOrigin).host);assert.equal(record.headers.origin,f.upstreamOrigin);
  for(const route of[prefix('elys-two')+'echo',prefix('elys-one','user-man')+'echo',prefix('foreign-only','user-lin','other')+'echo']){
    const isolated=await(await f.request(route,{headers:{Cookie:f.cookie+'; '+scoped}})).json();assert.equal(isolated.headers.cookie,undefined);
  }
});

test('Elys forwards scoped POST body, streams events promptly, and preserves compressed binary transport',async t=>{
  const f=await fixture(t);await f.setup();
  const body=JSON.stringify({message:'中文 task input'});
  const post=await f.request(prefix()+'api/echo?version=2',{method:'POST',headers:{'Content-Type':'application/json'},body});
  assert.equal(post.status,201);const record=await post.json();assert.equal(record.body,body);assert.equal(record.method,'POST');assert.equal(record.headers['content-type'],'application/json');
  const stream=await f.request(prefix()+'stream'),reader=stream.body.getReader();
  const first=await reader.read();assert.equal(f.streamEnded,false);assert.match(Buffer.from(first.value).toString(),/data: first/);
  let events=Buffer.from(first.value).toString();for(;;){const part=await reader.read();if(part.done)break;events+=Buffer.from(part.value).toString();}assert.match(events,/data: final/);
  const binary=await new Promise((resolve,reject)=>http.get(f.origin+prefix()+'binary',{headers:{Cookie:f.cookie,Origin:f.origin}},response=>{const chunks=[];response.on('data',part=>chunks.push(part));response.on('end',()=>resolve({headers:response.headers,body:Buffer.concat(chunks)}));response.on('error',reject);}).on('error',reject));
  assert.equal(binary.headers['content-encoding'],'gzip');assert.deepEqual(binary.body,f.compressed);
});

test('Elys rewrites relative redirects against the actual upstream request and rejects outside origins',async t=>{
  const f=await fixture(t);await f.setup();
  const relative=await f.request(prefix()+'nested/redirect');assert.equal(relative.status,302);assert.equal(relative.headers.get('location'),prefix()+'nested/next?complete=1#done');await relative.text();
  const outside=await f.request(prefix()+'external-redirect');assert.equal(outside.status,502);assert.equal((await outside.json()).code,'ELYS_PROJECT');
});
