import {test,expect} from '@playwright/test';
test('thread focuses conversation, exposes structured tool results, and retains failed run truth',async({page})=>{
 await page.goto('/threads/new');
 const password='local-e2e-owner-password-not-a-secret';
 await page.getByLabel('Password',{exact:true}).fill(password);
 if(await page.getByRole('button',{name:'Create owner account',exact:true}).count()){
  await page.getByLabel('Confirm password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create owner account',exact:true}).click();
 }else await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByLabel('Task prompt',{exact:true})).toBeVisible();
 const session=await (await page.request.get('/api/session')).json();
 const saved=await (await page.request.get('/api/state')).json();
 const w=saved.state.workspaces.find((w:any)=>w.id===saved.state.active);
 w.data.threads.push({id:'thread-parity-fixture',title:'Parity fixture',summary:'',time:'just now',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{id:'user-fixture',role:'user',text:'A synthetic search test',createdAt:new Date().toISOString()},{id:'assistant-fixture',role:'assistant',text:'A saved answer.',createdAt:new Date().toISOString(),toolRuns:[{id:'tool-fixture',name:'exa_search',status:'success',summary:JSON.stringify({status:'ok',query:'hello world',results:[{title:'Hello world source',url:'https://example.org/source',excerpt:'Real projected fixture excerpt.'}]})},{id:'tool-error-fixture',name:'web_fetch',status:'error',summary:'Upstream unavailable'},{id:'tool-approval-fixture',name:'shell_execute',status:'success',summary:JSON.stringify({status:'approval_required'})}]}]});
 const put=await page.request.put('/api/state',{headers:{'X-CSRF-Token':session.csrfToken,'If-Match':String(saved.revision),'Origin':new URL(page.url()).origin},data:{state:saved.state}});expect(put.ok()).toBeTruthy();
 await page.goto('/thread/thread-parity-fixture');
 await expect(page.getByLabel('Conversation',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Thread artifacts',{exact:true})).toBeHidden();
 const tools=page.getByLabel('Tool activity',{exact:true});await expect(tools).toBeVisible();
 await tools.locator('summary').filter({hasText:/Searching the web|Search the web|Web search/i}).first().click();
 const link=tools.getByRole('link',{name:/Hello world source/});await expect(link).toHaveAttribute('href','https://example.org/source');await expect(link).toHaveAttribute('rel',/noopener/);
 await expect(tools).toContainText(/approval/i);await expect(tools).toContainText(/Failed|Error/i);
 await page.getByRole('button',{name:'Show canvas',exact:true}).click();await expect(page.getByLabel('Thread artifacts',{exact:true})).toBeVisible();
 let state='waiting_approval';
 await page.route('**/api/runs**',route=>{
   const run={id:'synthetic-run',workspaceId:w.id,threadId:'thread-parity-fixture',userMessageId:'user-fixture',status:state,createdAt:new Date().toISOString(),toolCount:1,resultSaved:true,error:state==='failed'?'Synthetic failure remains visible':undefined,approvals:state==='waiting_approval'?[{id:'synthetic-review',status:'pending',command:'echo synthetic',cwd:'/tmp',timeoutSeconds:10}]:[]};
   return route.fulfill({json:route.request().url().includes('/events?')?{run,events:[],nextCursor:0,hasMore:false}:{runs:[run]}});
 });
 await page.reload();
 const review=page.getByLabel('Shell command review',{exact:true});await expect(review).toBeVisible();await expect(page.getByRole('button',{name:'Stop run',exact:true})).toBeVisible();
 await page.locator('.rt-run-details > summary').click();await expect(review).toBeVisible();
 state='failed';await page.reload();await expect(page.getByText('Synthetic failure remains visible',{exact:true})).toBeVisible();
 await expect(page.locator('.rt-run-details')).not.toHaveAttribute('open','');
 await page.setViewportSize({width:390,height:844});
 const bounds=await page.getByLabel('Conversation',{exact:true}).boundingBox();expect(bounds).not.toBeNull();expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(391);
});
