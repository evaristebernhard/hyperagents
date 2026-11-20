import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
const exec=promisify(execFile);
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});

test('public development ingress never starts before an owner exists, even with spoofable loopback proxy headers',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'hyperagents-ingress-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const apiPort=await freePort(),vitePort=await freePort();
  const env={...process.env,APP_ENV_FILE:'none',APP_DATA_DIR:dir,APP_PORT:String(apiPort),APP_HOST:'127.0.0.1',APP_PUBLIC_ORIGIN:'https://workspace.example'};
  delete env.APP_OWNER_PASSWORD;
  let failed;
  try {await exec(process.execPath,['scripts/dev.mjs','--host','0.0.0.0','--port',String(vitePort)],{cwd:path.resolve('.'),env,timeout:10000});}
  catch(error){failed=error;}
  assert.ok(failed);assert.equal(failed.code,1);assert.match(failed.stderr,/Development startup failed/);
  const db=new DatabaseSync(path.join(dir,'workspace.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner').get().n,0);db.close();
  await assert.rejects(fetch(`http://127.0.0.1:${vitePort}/api/setup`,{method:'POST',headers:{Host:`localhost:${vitePort}`,Origin:`http://localhost:${vitePort}`,'Content-Type':'application/json'},body:JSON.stringify({password:'attacker-test-only-password'})}));
});

for (const stage of ['API','Vite']) {
  test(`development startup identifies an occupied ${stage} port and exits cleanly`,async t=>{
    const dir=await mkdtemp(path.join(tmpdir(),'hyperagents-port-conflict-'));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const occupied=net.createServer();
    await new Promise((resolve,reject)=>{occupied.once('error',reject);occupied.listen(0,'127.0.0.1',resolve);});
    t.after(()=>new Promise(resolve=>occupied.close(resolve)));
    const busyPort=occupied.address().port,availablePort=await freePort();
    const apiPort=stage==='API'?busyPort:availablePort,vitePort=stage==='Vite'?busyPort:availablePort;
    const env={...process.env,APP_ENV_FILE:'none',APP_DATA_DIR:dir,APP_PORT:String(apiPort),APP_HOST:'127.0.0.1'};
    delete env.APP_OWNER_PASSWORD;
    delete env.APP_PUBLIC_ORIGIN;
    await assert.rejects(exec(process.execPath,['scripts/dev.mjs','--port',String(vitePort)],{cwd:path.resolve('.'),env,timeout:15000}),error=>{
      assert.equal(error.code,1);
      assert.ok(error.stderr.includes(`${stage} port ${busyPort} is already in use`));
      assert.match(error.stderr,stage==='API'?/set APP_PORT/:/--port <port>/);
      return true;
    });
    // A failed Vite start must also release the API port and scheduler lock.
    const {createApp}=await import('./app.mjs');
    const app=await createApp({dataDir:dir,port:stage==='Vite'?apiPort:0});
    try {await app.listen();} finally {await app.close();}
  });
}
