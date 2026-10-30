import {test} from 'node:test';
import assert from 'node:assert/strict';
import {marketplaceCatalog,marketplaceCapabilities,requiredSkillTools} from './marketplace.mjs';
import {emptyState} from './validation.mjs';

test('observed marketplace catalog preserves unique source identities and all category memberships',()=>{
  const {entries,categories}=marketplaceCatalog;
  assert.equal(entries.length,61);assert.equal(new Set(entries.map(e=>e.sourceId)).size,61);
  assert.equal(entries.filter(e=>e.kind==='skill').length,36);assert.equal(entries.filter(e=>e.kind==='agent').length,25);assert.equal(categories.length,8);
  for(const e of entries){assert.match(e.sourceUrl,/^https:\/\/hyperagent\.com\/marketplace\/[as]\//);assert.ok(e.categories.every(id=>categories.some(c=>c.id===id)));if(e.implementation){assert.match(e.implementation.documentation,/independently written/);assert.ok(e.implementation.limitations);}}
});
test('capabilities disclose configuration only; secrets and unconfigured services never become executable',()=>{
  const result=marketplaceCapabilities({openAlexApiKey:'test-only-placeholder',deepseekConfigured:true,browserPath:'/missing/browser-for-test'});
  assert.equal(result.capabilities.OpenAlex.available,true);assert.equal(result.capabilities.Browser.available,false);assert.equal(result.capabilities.LLM.available,true);
  assert.doesNotMatch(JSON.stringify(result),/test-only-placeholder/);assert.equal(marketplaceCapabilities().capabilities.OpenAlex.available,false);
});
test('only explicitly selected, unchanged installed templates bind API tools in the matching workspace',()=>{
  const state=emptyState(),data=state.workspaces[0].data;
  const source=marketplaceCatalog.entries.find(e=>e.name==='US National Weather Service API');
  data.skills.push({id:'weather-skill',sourceId:source.sourceId,name:source.name,documentation:source.implementation.documentation});
  data.threads.push({id:'t',messages:[{id:'m',role:'user',text:'Forecast',context:{skillIds:['weather-skill']}}]});
  assert.ok(requiredSkillTools(state,{workspaceId:'personal',threadId:'t'}).includes('Weather'));
  assert.deepEqual(requiredSkillTools(state,{workspaceId:'other',threadId:'t'}),[]);
  data.threads[0].messages[0].context.skillIds=[];assert.deepEqual(requiredSkillTools(state,{workspaceId:'personal',threadId:'t'}),[]);
  data.threads[0].messages[0].context.skillIds=['weather-skill'];data.skills[0].documentation='Edited user content';assert.deepEqual(requiredSkillTools(state,{workspaceId:'personal',threadId:'t'}),[]);
});
