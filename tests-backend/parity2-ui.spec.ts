import {test,expect} from '@playwright/test';
test('saved follow-ups prefill only, timing and resolved hints display, integrations opens real settings',async({page})=>{
 await page.goto('/threads/new');await page.getByLabel('Password',{exact:true}).fill('synthetic-parity2-password');await page.getByLabel('Confirm password',{exact:true}).fill('synthetic-parity2-password');await page.getByRole('button',{name:'Create owner account',exact:true}).click();await expect(page.getByLabel('Task prompt',{exact:true})).toBeVisible();
 const session=await (await page.request.get('/api/session')).json();const saved=await (await page.request.get('/api/state')).json();const w=saved.state.workspaces.find((x:any)=>x.id===saved.state.active);const time=new Date().toISOString();
 w.data.memories.push({id:'memory-parity2',content:'A synthetic context fact',category:'fact',pinned:true,importance:3});
 w.data.threads.push({id:'thread-parity2',title:'Original-style thread',summary:'',time:'just now',messages:[{id:'user-parity2',role:'user',text:'Research one topic',createdAt:time,context:{skillIds:[],memoryIds:['memory-parity2'],artifactIds:[],integrationIds:[],attachments:[]}},{id:'answer-parity2',role:'assistant',text:'A genuine stored answer.',createdAt:time,followUps:['Compare the options','Find the original source'],reasoningMs:1250,knowledgeHints:{skillIds:[],memoryIds:['memory-parity2']}}]});
 const put=await page.request.put('/api/state',{headers:{'X-CSRF-Token':session.csrfToken,'If-Match':String(saved.revision),'Origin':'http://127.0.0.1:21988'},data:{state:saved.state}});expect(put.ok(),await put.text()).toBeTruthy();
 await page.goto('/thread/thread-parity2');await expect(page.getByText(/Thought for|Reasoned for/).first()).toContainText(/1/);
 await expect(page.getByText(/1 knowledge hint|1 saved knowledge/).first()).toBeVisible();
 const box=page.getByLabel('Follow-up message',{exact:true});await box.fill('Unsent draft');
 const before=await (await page.request.get('/api/state')).json();
 await page.getByRole('button',{name:/Compare the options/}).click();await expect(box).toHaveValue('Unsent draft\n\nCompare the options');
 const after=await (await page.request.get('/api/state')).json();expect(after.revision).toEqual(before.revision);
 await page.locator('.rt-composer .integration-strip').click();await expect(page.getByRole('dialog',{name:'Settings',exact:true})).toBeVisible();await expect(page).toHaveURL(/settings=integrations/);
});
