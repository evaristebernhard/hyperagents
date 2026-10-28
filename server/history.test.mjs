import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.mjs';
import { DatabaseSync } from 'node:sqlite';
test('historical source tombstones survive deletion while live references stay validated',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'hyperagents-history-'));
  const app=await createApp({dataDir:dir,port:0});
  const address=await app.listen();const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  let headers={Origin:base,'Content-Type':'application/json'};
  const setup=await fetch(base+'/api/setup',{method:'POST',headers,body:JSON.stringify({password:'history-test-only-password'})});
  const session=await setup.json();assert.equal(setup.status,200);
  headers={...headers,Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrfToken};
  const loaded=await (await fetch(base+'/api/state',{headers})).json();const data=loaded.state.workspaces[0].data;
  const timestamp=new Date().toISOString();
  data.skills.push({id:'old-skill',name:'Source skill',description:'',documentation:'Instructions',whenToUse:'',tags:[],author:'Owner',createdAt:timestamp,updatedAt:timestamp});
  data.agents.push({id:'old-agent',name:'Source agent',description:'',prompt:'Verify',skillIds:['old-skill']});
  const config={model:'',reasoning:'Medium',provider:'Any',mode:'Execute',tools:[],agentId:'old-agent'};
  data.threads.push({id:'history-thread',title:'Historical context',summary:'',time:'',config,messages:[{id:'history-message',role:'user',text:'Keep the historical reference',context:{settings:structuredClone(config),skillIds:['old-skill'],memoryIds:[],artifactIds:[],integrationIds:[],attachments:[]}}]});
  let response=await fetch(base+'/api/state',{method:'PUT',headers:{...headers,'If-Match':'0'},body:JSON.stringify({state:loaded.state})});assert.equal(response.status,200);
  data.agents=[];data.skills=[];delete data.threads[0].config.agentId;
  response=await fetch(base+'/api/state',{method:'PUT',headers:{...headers,'If-Match':'1'},body:JSON.stringify({state:loaded.state})});assert.equal(response.status,200);
  const stored=await (await fetch(base+'/api/state',{headers})).json();
  assert.equal(stored.state.workspaces[0].data.threads[0].messages[0].context.settings.agentId,'old-agent');
  data.threads[0].config.agentId='missing-live-agent';
  response=await fetch(base+'/api/state',{method:'PUT',headers:{...headers,'If-Match':'2'},body:JSON.stringify({state:loaded.state})});assert.equal(response.status,422);
});

test('future or unrecognized databases are rejected without adding schema records',async t=>{
  for (const future of [true,false]) {
    const dir=await mkdtemp(path.join(tmpdir(),'hyperagents-schema-'));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const filename=path.join(dir,'workspace.sqlite');
    let db=new DatabaseSync(filename);
    if (future) db.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (2);');
    else db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep me');");
    db.close();
    await assert.rejects(createApp({dataDir:dir,port:0}),/database|schema/i);
    db=new DatabaseSync(filename);
    if (future) assert.deepEqual(db.prepare('SELECT version FROM schema_version').all().map(r=>r.version),[2]);
    else assert.equal(db.prepare('SELECT value FROM unrelated').get().value,'keep me');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='workspace'").get().n,0);
    db.close();
  }
});
