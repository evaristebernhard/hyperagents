import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.mjs';
const password='testing-password-not-a-real-secret';
async function harness(t,options={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'keystone-backend-'));
  let app,base,origin,cookie,csrf;
  async function start() { app=await createApp({dataDir:dir,port:0,...options}); const addr=await app.listen(); base=`http://127.0.0.1:${addr.port}`;origin=base; }
  await start();
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  async function request(route,opts={}) {
    const headers={...(cookie?{Cookie:cookie}:{}),Origin:origin,...(csrf?{'X-CSRF-Token':csrf}:{}),...(opts.body!==undefined?{'Content-Type':'application/json'}:{}),...opts.headers};
    const res=await fetch(base+route,{...opts,headers,body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
    const contentType=res.headers.get('content-type') || '';
    const data=contentType.startsWith('application/json')?await res.json():Buffer.from(await res.arrayBuffer());
    return {res,status:res.status,data};
  }
  async function setup() { const r=await request('/api/setup',{method:'POST',body:{password}}); assert.equal(r.status,200,JSON.stringify(r.data)); cookie=r.res.headers.get('set-cookie').split(';')[0]; csrf=r.data.csrfToken; return r; }
  return {dir,request,setup,get base(){return base;},get csrf(){return csrf;},get cookie(){return cookie;},async restart(){await app.close();await start();},async login(){const r=await request('/api/login',{method:'POST',body:{password}});assert.equal(r.status,200);cookie=r.res.headers.get('set-cookie').split(';')[0];csrf=r.data.csrfToken;return r;}};
}
async function state(h) { const r=await h.request('/api/state'); assert.equal(r.status,200); return r.data; }
async function save(h,s,revision) { return h.request('/api/state',{method:'PUT',body:{state:s},headers:{'If-Match':String(revision)}}); }
function thread(id='thread-1') { return {id,title:'Private title',summary:'',time:'',messages:[{id:'message-1',role:'user',text:'Real user text',createdAt:'2026-01-01T00:00:00Z',context:{settings:{model:'do not share',reasoning:'Medium',provider:'Any',mode:'Execute',tools:[]},skillIds:[],memoryIds:[],artifactIds:[],integrationIds:[],attachments:[]}}]}; }
async function upload(h,bytes=Buffer.from('<html>unsafe</html>'),opts={}) {
  const res=await fetch(h.base+'/api/files?workspaceId='+(opts.workspaceId ?? 'personal'),{method:'POST',headers:{Cookie:h.cookie,Origin:h.base,'X-CSRF-Token':h.csrf,'X-File-Name':encodeURIComponent(opts.name ?? 'real notes.html'),'Content-Type':opts.mime ?? 'text/html',...opts.headers},body:bytes});
  return {status:res.status,res,data:await res.json()};
}

test('empty durable workspace, owner setup, cookie, CAS and restart persistence',async t=>{
  const h=await harness(t);
  assert.deepEqual((await h.request('/api/session')).data,{authenticated:false,setupRequired:true});
  assert.equal((await h.request('/api/state')).status,401);
  assert.equal((await h.request('/api/status')).status,200);
  assert.equal((await h.request('/health')).status,404);
  const setup=await h.setup();
  assert.match(setup.res.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Path=\/; Max-Age=/);
  assert.doesNotMatch(setup.res.headers.get('set-cookie'),/Domain=/);
  let current=await state(h);
  assert.equal(current.revision,0); assert.equal(current.state.workspaces.length,1);
  for (const a of Object.values(current.state.workspaces[0].data)) assert.deepEqual(a,[]);
  current.state.workspaces[0].data.threads.push(thread());
  current.state.workspaces[0].data.preferences={defaultThreadSettings:{model:'chosen',reasoning:'Medium',provider:'Any',mode:'Execute',tools:[]}};
  assert.equal((await save(h,current.state,0)).data.revision,1);
  const conflict=await save(h,current.state,0);assert.equal(conflict.status,409);assert.equal(conflict.data.code,'CONFLICT');
  await h.restart();current=await state(h); assert.equal(current.revision,1);assert.equal(current.state.workspaces[0].data.threads[0].messages.length,1);
  assert.equal(current.state.workspaces[0].data.preferences.defaultThreadSettings.model,'chosen');
  assert.equal((await h.request('/api/setup',{method:'POST',body:{password}})).status,409);
  const db=new DatabaseSync(path.join(h.dir,'workspace.sqlite'));
  const owner=db.prepare('SELECT * FROM owner').get();assert.notEqual(owner.digest,password);assert.ok(owner.salt.length>=43);assert.equal(owner.digest.length,128);
  const sessions=db.prepare('SELECT * FROM sessions').all(); assert.ok(!JSON.stringify(sessions).includes(h.cookie.split('=')[1]));db.close();
});

test('origin/host/CSRF controls, logout, expiry and rate limits',async t=>{
  const h=await harness(t);await h.setup();const current=await state(h);
  for (const origin of [undefined,'http://evil.example','null']) {
    const headers={'If-Match':'0',Origin:origin};
    // Fetch converts undefined values to strings; raw missing-origin is tested separately.
    assert.equal((await h.request('/api/state',{method:'PUT',headers,body:current.state})).status,403);
  }
  const missingOrigin=await fetch(h.base+'/api/logout',{method:'POST',headers:{Cookie:h.cookie,'X-CSRF-Token':h.csrf}});assert.equal(missingOrigin.status,403);
  assert.equal((await h.request('/api/state',{headers:{Origin:'http://evil.example'}})).status,403);
  const foreignHost=await new Promise((resolve,reject)=>{const req=http.get(h.base+'/api/state',{headers:{Host:'evil.example',Cookie:h.cookie}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});
  assert.equal(foreignHost,403);
  assert.equal((await h.request('/api/logout',{method:'POST',headers:{Origin:'http://evil.example','X-Forwarded-Host':'127.0.0.1','X-Forwarded-Proto':'https'}})).status,403);
  assert.equal((await h.request('/api/state',{method:'PUT',body:current.state,headers:{'If-Match':'0','X-CSRF-Token':'wrong'}})).status,403);
  assert.equal((await h.request('/api/login',{method:'POST',body:{password},headers:{'Content-Type':'text/plain'}})).status,400);
  assert.equal((await h.request('/api/login',{method:'POST',body:{password:'incorrect-password'}})).status,401);
  assert.equal((await h.request('/api/logout',{method:'POST'})).status,200);
  assert.equal((await h.request('/api/state')).status,401);
  await h.login();
  const db=new DatabaseSync(path.join(h.dir,'workspace.sqlite'));db.prepare('UPDATE sessions SET expires=0').run();db.close();
  assert.equal((await h.request('/api/state')).status,401);
  let limited=false;for(let i=0;i<12;i++){const r=await h.request('/api/login',{method:'POST',body:{password:'incorrect-password'}});if(r.status===429){assert.equal(r.res.headers.get('retry-after'),'900');limited=true;break;}}assert.ok(limited);
});

test('explicit public origin: setup denied, HTTPS cookie secure, external binding gated',async t=>{
  const h=await harness(t,{publicOrigin:'https://app.example'});
  assert.equal((await h.request('/api/setup',{method:'POST',headers:{Origin:'https://app.example'},body:{password}})).status,403);
  const publicHostSetup=await new Promise((resolve,reject)=>{const req=http.request(h.base+'/api/setup',{method:'POST',headers:{Host:'app.example',Origin:h.base,'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({password}));});
  assert.equal(publicHostSetup,403);
  await h.setup();
  const login=await h.request('/api/login',{method:'POST',headers:{Origin:'https://app.example'},body:{password}});
  assert.equal(login.status,200);assert.match(login.res.headers.get('set-cookie'),/; Secure/);
  const dir=await mkdtemp(path.join(tmpdir(),'keystone-bind-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await assert.rejects(createApp({dataDir:dir,host:'0.0.0.0',port:0}),/External binding/);
  const app=await createApp({dataDir:dir,host:'0.0.0.0',port:0,ownerPassword:password});await app.listen();await app.close();
  const reopened=await createApp({dataDir:dir,host:'0.0.0.0',port:0,ownerPassword:'ignored-invalid-short'});await reopened.close();
});

test('validation rejects arbitrary objects, malformed nested data and dangling references atomically',async t=>{
  const h=await harness(t);await h.setup();const initial=(await state(h)).state;
  const invalids=[];
  let s=structuredClone(initial);s.workspaces[0].data.threads.push({id:'oops',title:42});invalids.push(s);
  s=structuredClone(initial);s.workspaces[0].data.threads.push({...thread(),projectId:'missing'});invalids.push(s);
  s=structuredClone(initial);s.workspaces[0].data.threads.push({...thread(),messages:[{role:'system',text:'bad'}]});invalids.push(s);
  s=structuredClone(initial);s.workspaces[0].data.preferences=JSON.parse('{"__proto__":{}}');invalids.push(s);
  s=structuredClone(initial);s.workspaces[0].data.threads.push({...thread(),execute:'rm -rf'});invalids.push(s);
  s=structuredClone(initial);s.workspaces[0].data.threads.push({...thread(),messages:[{role:'user',text:'x',context:{attachments:[{id:'file-bogus',name:'pretend',size:1,mimeType:'x/y',createdAt:'today',workspaceId:'personal'}]}}]});invalids.push(s);
  s=structuredClone(initial);s.workspaces.push(s.workspaces[0]);invalids.push(s);
  for (const bad of invalids) assert.equal((await save(h,bad,0)).status,422);
  assert.equal((await state(h)).revision,0);
  assert.equal((await h.request('/api/state',{method:'PUT',body:initial})).status,400);
  const oversized=structuredClone(initial);oversized.workspaces[0].data.preferences={text:'x'.repeat(10*1024*1024)};
  assert.equal((await save(h,oversized,0)).status,413);
  assert.equal((await state(h)).revision,0);
});

test('real file bytes, metadata associations, download safety, size limits, no orphan deletion and restart',async t=>{
  const h=await harness(t,{maxFileBytes:128});await h.setup();
  const uploaded=await upload(h);assert.equal(uploaded.status,201);const f=uploaded.data.file;
  assert.equal(f.size,19);assert.equal(f.name,'real notes.html');
  const r=await h.request(`/api/files/${f.id}?workspaceId=personal`);assert.equal(r.status,200);assert.equal(r.data.toString(),'<html>unsafe</html>');
  assert.match(r.res.headers.get('content-disposition'),/^attachment;/);assert.equal(r.res.headers.get('content-type'),'application/octet-stream');assert.equal(r.res.headers.get('x-content-type-options'),'nosniff');assert.match(r.res.headers.get('content-security-policy'),/sandbox/);
  assert.equal((await upload(h,Buffer.alloc(129))).status,413);
  assert.equal((await upload(h,Buffer.alloc(1),{workspaceId:'missing'})).status,422);
  for (const name of ['../escape','..','a\\b','a\nb']) assert.equal((await upload(h,Buffer.alloc(1),{name})).status,422);
  assert.equal((await upload(h,Buffer.from('x'),{headers:{'X-CSRF-Token':'bad'}})).status,403);
  let current=await state(h);current.state.workspaces[0].data.threads.push(thread());current.state.workspaces[0].data.threads[0].messages[0].context.attachments=[f];
  assert.equal((await save(h,current.state,0)).status,200);
  current.state.workspaces.push({id:'other',name:'Other',data:structuredClone(current.state.workspaces[0].data)});current.state.workspaces[1].data.threads=[];
  assert.equal((await save(h,current.state,1)).status,200);
  assert.equal((await h.request(`/api/files/${f.id}?workspaceId=other`)).status,404);
  current.state.workspaces[0].data.threads=[];assert.equal((await save(h,current.state,2)).status,200);
  await h.restart();assert.equal((await h.request(`/api/files/${f.id}?workspaceId=personal`)).data.toString(),'<html>unsafe</html>');
  assert.deepEqual((await readdir(path.join(h.dir,'uploads'))),[f.id]);
  assert.equal(await readFile(path.join(h.dir,'uploads',f.id),'utf8'),'<html>unsafe</html>');
});

test('chunked upload limit returns 413 and removes partial files',async t=>{
  const h=await harness(t,{maxFileBytes:16});await h.setup();
  const status=await new Promise((resolve,reject)=>{
    const req=http.request(h.base+'/api/files?workspaceId=personal',{method:'POST',headers:{Cookie:h.cookie,Origin:h.base,'X-CSRF-Token':h.csrf,'X-File-Name':'chunked.txt','Content-Type':'text/plain'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(Buffer.alloc(10));req.write(Buffer.alloc(10));req.end();
  });assert.equal(status,413);assert.deepEqual(await readdir(path.join(h.dir,'uploads')),[]);
});

test('immutable minimal public shares, explicit thread artifacts, file privacy and revocation',async t=>{
  const h=await harness(t);await h.setup();const f=(await upload(h)).data.file;
  let current=await state(h);const data=current.state.workspaces[0].data;const th=thread();th.messages[0].context.attachments=[f];data.threads.push(th);
  const artifact={id:'artifact-1',title:'Chosen',kind:'Document',content:'Public selected content',threadId:th.id,versions:[],createdAt:'today',updatedAt:'today'};data.artifacts.push(artifact,{...artifact,id:'private-artifact',title:'Private',content:'NOT CHOSEN'});
  assert.equal((await save(h,current.state,0)).status,200);
  const created=await h.request('/api/shares',{method:'POST',body:{workspaceId:'personal',threadId:th.id,artifactIds:['artifact-1']}});assert.equal(created.status,201);const share=created.data.share;assert.ok(Buffer.from(share.token,'base64url').length>=32);
  const publicRes=await fetch(h.base+'/api/public/shares/'+share.token);assert.equal(publicRes.status,200);const snapshot=await publicRes.json();
  assert.deepEqual(Object.keys(snapshot).sort(),['artifacts','createdAt','messages','title']);assert.deepEqual(snapshot.messages[0].attachments,[{name:f.name}]);
  for(const secret of [f.id,'private-artifact','NOT CHOSEN','settings','workspaceId','context','do not share']) assert.ok(!JSON.stringify(snapshot).includes(secret),secret);
  assert.equal((await fetch(h.base+'/api/state')).status,401);assert.equal((await fetch(h.base+`/api/files/${f.id}?workspaceId=personal`)).status,401);
  assert.equal((await h.request('/api/shares',{method:'POST',body:{workspaceId:'personal',threadId:th.id,artifactIds:['not-chosen-or-existent']}})).status,422);
  assert.equal((await fetch(h.base+'/api/public/shares/'+share.token,{method:'DELETE',headers:{Origin:h.base}})).status,401);
  const list=await h.request('/api/shares?workspaceId=personal&threadId='+th.id);assert.equal(list.data.shares.length,1);
  data.threads[0].title='Changed';data.threads[0].messages[0].text='Changed';data.artifacts[0].content='Changed';assert.equal((await save(h,current.state,1)).status,200);
  await h.restart();assert.deepEqual(await (await fetch(h.base+'/api/public/shares/'+share.token)).json(),snapshot);
  assert.equal((await h.request('/api/shares/'+share.id,{method:'DELETE'})).status,200);
  assert.equal((await fetch(h.base+'/api/public/shares/'+share.token)).status,404);
  assert.equal((await fetch(h.base+'/api/public/shares/not-valid')).status,404);
  await h.restart();assert.equal((await fetch(h.base+'/api/public/shares/'+share.token)).status,404);
});

test('explicit migration appends fresh workspace IDs, preserves resources, conflicts never overwrite',async t=>{
  const h=await harness(t);await h.setup();let current=await state(h);current.state.workspaces[0].data.threads.push(thread());assert.equal((await save(h,current.state,0)).status,200);
  const legacy=structuredClone(current.state);legacy.workspaces[0].data.threads[0].title='Legacy imported';
  const migrated=await h.request('/api/migrate',{method:'POST',body:{state:legacy,revision:1}});assert.equal(migrated.status,200);assert.equal(migrated.data.revision,2);
  const ws=migrated.data.state.workspaces;assert.equal(ws.length,2);assert.equal(ws[0].id,'personal');assert.equal(ws[0].data.threads[0].title,'Private title');assert.notEqual(ws[1].id,'personal');assert.match(ws[1].name,/\(imported\)$/);assert.equal(ws[1].data.threads[0].id,'thread-1');assert.equal(ws[1].data.threads[0].title,'Legacy imported');
  assert.equal((await h.request('/api/migrate',{method:'POST',body:{state:legacy,revision:1}})).status,409);
  assert.equal((await h.request('/api/migrate',{method:'POST',body:{state:{anything:'arbitrary'},revision:2}})).status,422);
  const missingBytes=structuredClone(legacy);missingBytes.workspaces[0].data.threads[0].messages[0].context.attachments=[{id:'file-missing',name:'old.txt',size:8,mimeType:'text/plain',createdAt:'today',workspaceId:'personal'}];
  assert.equal((await h.request('/api/migrate',{method:'POST',body:{state:missingBytes,revision:2}})).status,422);
  await h.restart();assert.equal((await state(h)).state.workspaces.length,2);
});

test('optional dist serving is opt-in, has SPA fallback but rejects dotfiles and symlink escape',async t=>{
  const dist=await mkdtemp(path.join(tmpdir(),'keystone-dist-'));t.after(()=>rm(dist,{recursive:true,force:true}));await writeFile(path.join(dist,'index.html'),'<main>real built UI</main>');await writeFile(path.join(dist,'.env'),'SECRET');await symlink('/etc/passwd',path.join(dist,'escape.txt'));
  const h=await harness(t,{distDir:dist});
  assert.match((await h.request('/share/token')).data.toString(),/real built UI/);
  assert.equal((await h.request('/.env')).status,404);
  assert.equal((await h.request('/escape.txt')).status,404);
  assert.equal((await h.request('/api/state')).status,401);
});


test('concurrent CAS writes have exactly one winner and never merge/overwrite silently',async t=>{
  const h=await harness(t);await h.setup();const initial=(await state(h)).state;
  const first=structuredClone(initial),second=structuredClone(initial);first.workspaces[0].name='First';second.workspaces[0].name='Second';
  const results=await Promise.all([save(h,first,0),save(h,second,0)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const winner=results[0].status===200?'First':'Second';
  assert.equal((await state(h)).state.workspaces[0].name,winner);await h.restart();assert.equal((await state(h)).state.workspaces[0].name,winner);
});
