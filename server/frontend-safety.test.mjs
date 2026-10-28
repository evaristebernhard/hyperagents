import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isPrivateDataRequest } from '../scripts/private-data.mjs';
import { SnapshotLock } from '../src/snapshot-lock.ts';

test('development filesystem guard denies private data, raw imports, database sidecars and aliases', async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'hyperagents-fs-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const root=path.join(base,'project'),dataDir=path.join(base,'private-store');
  await mkdir(path.join(root,'public'),{recursive:true});await mkdir(path.join(dataDir,'uploads'),{recursive:true});
  await writeFile(path.join(dataDir,'workspace.sqlite'),'private db');await writeFile(path.join(dataDir,'uploads','file-1'),'private bytes');
  await symlink(path.join(dataDir,'uploads','file-1'),path.join(root,'public','innocent.txt'));
  const options={root,dataDir};
  for(const url of [
    '/.data/workspace.sqlite','/.data/uploads/file-1','/%2edata/uploads/file-1?raw',
    '/@fs'+path.join(dataDir,'workspace.sqlite')+'?raw','/@fs'+path.join(dataDir,'uploads','file-1'),
    '/@fs'+path.join(root,'.data','workspace.sqlite-wal'),'/some.db-shm?url','/innocent.txt',
  ]) assert.equal(isPrivateDataRequest(url,options),true,url);
  for(const url of ['/src/main.tsx','/src/data.ts','/api/state','/api/files/file-abc?workspaceId=personal','/examples/campaign.svg']) assert.equal(isPrivateDataRequest(url,options),false,url);
});

test('snapshot replacement waits for old writes and rejects concurrent edits or replacement',async()=>{
  const lock=new SnapshotLock();let releaseSave,releaseMigration;
  const save=new Promise(resolve=>releaseSave=resolve),migration=new Promise(resolve=>releaseMigration=resolve);
  const events=[];
  const replaced=lock.run(async()=>{events.push('wait-save');await save;events.push('save-ack');},async()=>{events.push('migration');await migration;events.push('install');});
  assert.equal(lock.locked,true);assert.throws(()=>lock.assertMutable(),/replacement/);
  await assert.rejects(lock.run(async()=>{},async()=>{}),/replacement/);
  assert.deepEqual(events,['wait-save']);releaseSave();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['wait-save','save-ack','migration']);assert.throws(()=>lock.assertMutable(),/replacement/);
  releaseMigration();await replaced;assert.equal(lock.locked,false);lock.assertMutable();
  assert.deepEqual(events,['wait-save','save-ack','migration','install']);
});

test('snapshot replacement unlocks after a failed save without installing a stale response',async()=>{
  const lock=new SnapshotLock();let installed=false;
  await assert.rejects(lock.run(async()=>{throw Error('save failed');},async()=>{installed=true;}),/save failed/);
  assert.equal(installed,false);assert.equal(lock.locked,false);
});
