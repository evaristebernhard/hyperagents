import {test,expect,type Page,type BrowserContext} from '@playwright/test';
import {readFileSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('../shared/marketplace-catalog.json',import.meta.url),'utf8'));
let cookies:Awaited<ReturnType<BrowserContext['cookies']>>|undefined;
const entry=(name:string)=>catalog.entries.find(e=>e.name===name)!;
const routeFor=(name:string)=>'/marketplace/'+(entry(name).kind==='skill'?'s/':'a/')+entry(name).sourceId;
async function login(page:Page){
 if(cookies){await page.context().addCookies(cookies);await page.goto('/threads/new');await expect(page.getByLabel('Task prompt',{exact:true})).toBeVisible();return;}
 await page.goto('/threads/new');await page.getByLabel('Password',{exact:true}).fill('local-e2e-owner-password-not-a-secret');
 if(await page.getByRole('button',{name:'Create owner account',exact:true}).count()){await page.getByLabel('Confirm password',{exact:true}).fill('local-e2e-owner-password-not-a-secret');await page.getByRole('button',{name:'Create owner account',exact:true}).click();}else await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByLabel('Task prompt',{exact:true})).toBeVisible();cookies=await page.context().cookies();
}
const state=async(page:Page)=>(await page.request.get('/api/state')).json();
async function install(page:Page,name:string){await page.goto(routeFor(name));await page.getByRole('button',{name:entry(name).kind==='skill'?'Install skill':'Create agent',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:entry(name).kind==='skill'?'Install skill':'Create agent',exact:true}).click();await expect(page).toHaveURL(new RegExp(entry(name).kind==='skill'?'/skills/skill-':'/agents/agent-market-'));await expect(page.getByLabel('Storage status',{exact:true})).toHaveText('Saved to local server');}
test.beforeEach(async({page})=>login(page));
test('marketplace has the observed inventory, searchable types, category routes and honest source-only entries',async({page},info)=>{
 await page.goto('/marketplace');await expect(page.locator('.mp-catalog-facts')).toContainText('61 original listings');await expect(page.getByLabel('Marketplace categories')).toContainText('Research');
 await page.getByRole('button',{name:'Skills',exact:true}).click();await expect(page.locator('.mp-result-meta')).toContainText('36 listings');
 await page.getByLabel('Search marketplace',{exact:true}).fill('weather');await expect(page.locator('.mp-card')).toHaveCount(1);await page.getByRole('link',{name:'US National Weather Service API',exact:true}).click();await expect(page.getByRole('heading',{name:'US National Weather Service API',exact:true})).toBeVisible();
 await page.goto('/marketplace/c/recruiting');await expect(page.locator('.mp-result-meta')).toContainText('2 listings');
 await page.goto(routeFor('Veo + Hyperframes Videos'));await expect(page.getByRole('button',{name:'Install skill',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'A source listing, not an installable implementation',exact:true})).toBeVisible();
 await page.goto('/marketplace');await page.screenshot({path:info.outputPath('marketplace-catalog.png'),fullPage:true});
});
test('independent skill installation persists exact authored documentation and does not duplicate on reopen',async({page})=>{
 await install(page,'Roast My Idea');const saved=await state(page);const list=saved.state.workspaces.flatMap((w:any)=>w.data.skills).filter((s:any)=>s.sourceId===entry('Roast My Idea').sourceId);expect(list).toHaveLength(1);expect(list[0].documentation).toBe(entry('Roast My Idea').implementation!.documentation);
 await page.reload();await expect(page.getByRole('heading',{name:'Roast My Idea',exact:true})).toBeVisible();await page.goto(routeFor('Roast My Idea'));await page.getByRole('button',{name:'Open installed skill',exact:true}).click();await expect(page).toHaveURL('/skills/'+list[0].id);expect((await state(page)).state.workspaces.flatMap((w:any)=>w.data.skills).filter((s:any)=>s.sourceId===entry('Roast My Idea').sourceId)).toHaveLength(1);
});
test('weather skill can be selected in a real task and automatically binds its API tool preference',async({page})=>{
 await install(page,'US National Weather Service API');await page.goto('/threads/new');await page.getByRole('button',{name:'Add files or context',exact:true}).click();await page.getByRole('button',{name:'Skills',exact:true}).click();await page.getByRole('dialog',{name:'Select skills',exact:true}).getByRole('button',{name:'US National Weather Service API',exact:true}).click();
 await page.getByLabel('Task prompt',{exact:true}).fill('Weather for 38.8977, -77.0365');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page).toHaveURL(/\/thread\/thread-/);await expect(page.getByLabel('Storage status',{exact:true})).toHaveText('Saved to local server');
 const saved=await state(page);const thread=saved.state.workspaces.flatMap((w:any)=>w.data.threads).find((t:any)=>t.title==='Weather for 38.8977, -77.0365');expect(thread.messages[0].context.settings.tools).toContain('Weather');expect(thread.messages[0].context.skillIds).toHaveLength(1);
});
test('an unconfigured API-backed skill cannot pretend to install or run',async({page})=>{
 await page.goto(routeFor('OpenAlex API'));await expect(page.getByRole('button',{name:'Install skill',exact:true})).toBeDisabled();await expect(page.locator('.mp-detail-aside')).toContainText('OPENALEX_API_KEY');
 const saved=await state(page);expect(saved.state.workspaces.flatMap((w:any)=>w.data.skills).some((s:any)=>s.sourceId===entry('OpenAlex API').sourceId)).toBe(false);
});
test('supported agent installs a real editable prompt and tool config without impersonating source',async({page})=>{
 await install(page,'Bottleneck Audit');const saved=await state(page),id='agent-market-'+entry('Bottleneck Audit').sourceId;const agent=saved.state.workspaces.flatMap((w:any)=>w.data.agents).find((a:any)=>a.id===id);expect(agent.prompt).toBe(entry('Bottleneck Audit').implementation!.documentation);expect(agent.tools).toContain('Documents');await page.goto(routeFor('Bottleneck Audit'));await expect(page.getByRole('button',{name:'Open installed agent',exact:true})).toBeVisible();
});
test('partial implementations disclose limitations and narrow marketplace has no horizontal overflow',async({page})=>{
 await page.goto(routeFor('NYT Data Viz'));await expect(page.getByRole('heading',{name:'Partial implementation — limitations',exact:true})).toBeVisible();await expect(page.locator('.mp-limitations')).toContainText('Static'.toLowerCase());
 await page.setViewportSize({width:390,height:844});await page.goto('/marketplace');await expect(page.getByLabel('Search marketplace',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test('a failed skill save remains unconfirmed and never reports an installed server record',async({page})=>{
 const source=entry('Brand Book Generator');await page.goto(routeFor(source.name));
 await page.route('**/api/state',route=>route.request().method()==='PUT'?route.fulfill({status:503,json:{error:'Test persistence unavailable'}}):route.continue());
 await page.getByRole('button',{name:'Install skill',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Install skill',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Test persistence unavailable');await expect(page).toHaveURL(routeFor(source.name));
 const saved=await state(page);expect(saved.state.workspaces.flatMap((w:any)=>w.data.skills).some((s:any)=>s.sourceId===source.sourceId)).toBe(false);
});
