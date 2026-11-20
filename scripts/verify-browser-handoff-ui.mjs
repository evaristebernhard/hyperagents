// Actual UI/auth/HTTP/SQLite; browser protocol and model replies are controlled fixtures.
// No production data, existing browser profile, account login or inference is accessed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createApp } from '../server/app.mjs';
import privateDataPlugin, { privateFsDeny } from './private-data.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=await mkdtemp(path.join(tmpdir(),'hyperagents-handoff-ui-'));
const output=path.join(root,'docs/verification-browser-handoff-ui');
const report={passed:false,scope:'Actual UI, owner setup, task input, HTTP and SQLite with synthetic provider/browser protocol. No real remote website, registration or inference.',checks:[],browserErrors:[],modelCalls:0};
const check=name=>report.checks.push({name,passed:true});
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const frame=value=>'data: '+(typeof value==='string'?value:JSON.stringify(value))+'\n\n';
const fixtureSession={id:'handoff-fixture-session',profileId:'handoff-fixture-profile',label:'本任务等待注册',url:'https://example.org/register',title:'隔离注册示例',status:'open',control:'agent',epoch:1,viewport:{width:1280,height:800},tabs:[{id:'fixture-tab',url:'https://example.org/register',title:'隔离注册示例'}],activeTabId:'fixture-tab'};
const otherSession={...fixtureSession,id:'unrelated-fixture-session',label:'之前查看的浏览器',url:'https://example.org/unrelated'};
let app,vite,browser,page,finishHandback;
const client={configured:true,
  async capabilities(){return{configured:true,available:true,persistent:true};},
  async open(){return{session:{...fixtureSession}};},
  async requestTakeover(){fixtureSession.control='paused';fixtureSession.epoch++;return{session:{...fixtureSession}};},
  async waitForHandback(_owner,_id,{signal}){return new Promise((resolve,reject)=>{finishHandback=()=>resolve({session:{...fixtureSession},observation:{title:'注册完成示例',text:'Owned fixture registration completed after explicit handback.'}});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},
  async release(){},
  async handle(req,res,{data}){
    const route=new URL(req.url,'http://fixture').pathname.replace('/api/browser','');
    let result;
    if(route==='/capabilities')result=await this.capabilities();
    else if(route==='/sessions')result={sessions:[otherSession,{...fixtureSession}]};
    else if(route===`/sessions/${fixtureSession.id}`)result={session:{...fixtureSession}};
    else if(route===`/sessions/${fixtureSession.id}/takeover`||route===`/sessions/${fixtureSession.id}/handback`){
      assert.equal(data.expectedEpoch,fixtureSession.epoch);
      fixtureSession.control=route.endsWith('/takeover')?'human':'agent';fixtureSession.epoch++;
      result={session:{...fixtureSession}};
      if(fixtureSession.control==='agent')finishHandback();
    }else if(route.endsWith('/screenshot')){
      res.writeHead(200,{'Content-Type':'image/png','X-Browser-Frame':'fixture-frame','X-Browser-Epoch':String(fixtureSession.epoch),'X-Browser-Revision':'1','X-Browser-Width':'1280','X-Browser-Height':'800'});
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHysAAAAASUVORK5CYII=','base64'));return true;
    }else throw Error('Unexpected browser fixture route '+route);
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return true;
  },
};

try{
  await mkdir(output,{recursive:true});
  const uiPort=await freePort(),base=`http://127.0.0.1:${uiPort}`;
  app=await createApp({dataDir:directory,port:0,devOrigin:base,deepseekApiKey:'isolated-handoff-provider',persistentBrowserClient:client,freeSearchDisabled:true,skillCatalog:[],integrationCredentials:{},llmFetch:async(_url,init)=>{
    report.modelCalls++;const request=JSON.parse(init.body);
    if(report.modelCalls<=2){const name=report.modelCalls===1?'browser_session':'browser_request_takeover',args=report.modelCalls===1?{action:'create',url:'https://example.org/register'}:{sessionId:fixtureSession.id};return new Response(frame({choices:[{delta:{tool_calls:[{index:0,id:'fixture-call-'+report.modelCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}});}
    assert.ok(request.messages.some(message=>message.role==='tool'&&message.content.includes('Owned fixture registration completed')));
    return new Response(frame({choices:[{delta:{content:'交还后已读取注册完成的示例页面。'},finish_reason:'stop'}]})+frame('[DONE]'),{headers:{'Content-Type':'text/event-stream'}});
  }});
  const apiPort=(await app.listen()).port;
  vite=await createServer({root,configFile:false,envFile:false,plugins:[privateDataPlugin(),react()],define:{'import.meta.env.VITE_STORAGE_MODE':'"server"','import.meta.env.VITE_BACKEND_V1':'"false"'},optimizeDeps:{entries:['index.html'],esbuildOptions:{target:'es2022'}},server:{host:'127.0.0.1',port:uiPort,strictPort:true,watch:null,fs:{strict:true,deny:privateFsDeny},proxy:{'/api':{target:`http://127.0.0.1:${apiPort}`,changeOrigin:false}}}});
  await vite.listen();
  if(process.env.HANDOFF_UI_CHROMIUM==='1'){
    browser=await chromium.launch({headless:true});page=await browser.newPage();report.browser='Chromium '+browser.version();
    report.fallback='Moli 1.1.19 exposes Task prompt in its semantic tree but reports it hidden under --layout; original attempt retained in moli-attempt.json. Explicit Chromium fallback.';
  }else{
    const cdp=process.env.MOLI_CDP||'http://127.0.0.1:19329';
    const discovery=await fetch(cdp+'/json/version');assert.equal(discovery.ok,true);report.browser=(await discovery.json()).Browser;
    browser=await chromium.connectOverCDP(cdp);page=await browser.contexts()[0].newPage();
  }
  page.setDefaultTimeout(20000);await page.setViewportSize({width:1440,height:1000});
  page.on('pageerror',error=>report.browserErrors.push(error.message));
  await page.goto(base+'/threads/new');
  await page.getByLabel('Password',{exact:true}).fill('isolated-handoff-ui-password');
  await page.getByLabel('Confirm password',{exact:true}).fill('isolated-handoff-ui-password');
  await page.getByRole('button',{name:'Create owner account',exact:true}).click();
  await expect(page.getByLabel('Task prompt',{exact:true})).toBeVisible();
  // Add only an empty configured fixture thread; the actual request is submitted in UI.
  await page.evaluate(async()=>{
    const session=await(await fetch('/api/session')).json();
    const current=await(await fetch('/api/state')).json();
    current.state.workspaces[0].data.threads.push({id:'handoff-ui-thread',title:'等待注册验收',summary:'',time:'',config:{model:'deepseek-flash',provider:'Any',reasoning:'Medium',mode:'Execute',tools:['Browser']},messages:[]});
    const response=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':String(current.revision),'X-CSRF-Token':session.csrfToken},body:JSON.stringify({state:current.state})});if(!response.ok)throw Error('Unable to prepare isolated fixture thread');
    localStorage.setItem('hyperagents:browser-view:v1:/api/browser:personal',JSON.stringify({sessionId:'unrelated-fixture-session'}));
  });
  await page.goto(base+'/thread/handoff-ui-thread');
  await page.getByLabel('Follow-up message',{exact:true}).fill('打开隔离注册示例，等待我接管，明确交还以后再继续。');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByLabel('Durable run status',{exact:true})).toContainText('等待你操作浏览器');
  await expect(page.getByRole('button',{name:'打开等待中的浏览器',exact:true})).toBeVisible();
  assert.equal(report.modelCalls,2);check('submitted UI task pauses model calls and presents registration waiting state');
  await page.reload();
  await expect(page.getByLabel('Durable run status',{exact:true})).toContainText('等待你操作浏览器');
  assert.equal(report.modelCalls,2);check('page reload replays persisted waiting event without starting another execution');
  await page.getByRole('button',{name:'打开等待中的浏览器',exact:true}).click();
  await expect(page.getByLabel('浏览器网址',{exact:true})).toHaveValue(fixtureSession.url);
  await expect(page.locator('.pb-state')).toHaveText('已暂停');check('open action selects task session instead of unrelated saved browser');
  await page.getByRole('button',{name:'接管浏览器',exact:true}).click();
  await expect(page.locator('.pb-state')).toHaveText('你正在接管');
  assert.equal(report.modelCalls,2);
  await page.getByRole('button',{name:'交还 AI',exact:true}).click();
  await expect(page.locator('.pb-state')).toHaveText('AI 控制');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Durable run status',{exact:true})).toContainText('Succeeded');
  await expect(page.locator('.rt-message.assistant:not([aria-label])').last()).toContainText('交还后已读取注册完成的示例页面。');
  assert.equal(report.modelCalls,3);await expect(page.getByRole('button',{name:'打开等待中的浏览器',exact:true})).toHaveCount(0);
  check('explicit handback receives same-session observation then continues exactly once');
  assert.deepEqual(report.browserErrors,[]);report.passed=true;
}catch(error){report.error=error.message;throw error;}
finally{
  await page?.close();await browser?.close();await vite?.close();await app?.close();await rm(directory,{recursive:true,force:true});
  report.temporaryDataRemoved=true;await mkdir(output,{recursive:true});await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
