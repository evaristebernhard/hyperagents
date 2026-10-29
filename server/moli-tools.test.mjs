import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {normalizeWebFetch,createMoliTools} from './moli-tools.mjs';

test('Moli web fetch validates public HTTPS targets and tool binding',()=>{
  assert.equal(normalizeWebFetch({url:'https://example.com/a'}).url,'https://example.com/a');
  assert.throws(()=>normalizeWebFetch({url:'http://example.com'}),/HTTPS/);
  assert.throws(()=>normalizeWebFetch({url:'https://127.0.0.1'}),/Private/);
  assert.equal(createMoliTools({enabled:[]}).definitions.length,0);
  assert.equal(createMoliTools({enabled:['Web Fetch']}).definitions[0].function.name,'web_fetch');
});

test('Moli web fetch returns bounded read-only content through its executable',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moli-tool-')),script=path.join(dir,'moli-fake.sh');
  await writeFile(script,'#!/bin/sh\nprintf "Synthetic Markdown\\n"\n', {mode:0o700});
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const tool=createMoliTools({enabled:['Web Fetch'],moliPath:script});
  const result=await tool.execute('web_fetch',{url:'https://example.com'});
  assert.deepEqual({status:result.status,engine:result.engine,content:result.content},{status:'ok',engine:'moli',content:'Synthetic Markdown\n'});
});
