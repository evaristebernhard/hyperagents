import { createExaTools } from './exa-tools.mjs';
import { browserConfiguration } from './browser-runtime.mjs';
import { accessSync, constants } from 'node:fs';
const EFFECTS=new Set(['read','write','external_side_effect']);
const BASE=[
 ['Search','web','read','exa_search'],['Find Similar','web','read','exa_find_similar'],['Exa Research','web','read',null],['Exa Websets','web','read',null],['Thread Search','workspace','read','search_threads'],['Documents','documents','write','create_artifact'],['Webpages','documents','write','create_artifact'],['Tables','documents','write','create_table'],['World Bank','web','read','world_bank_indicator'],['Weather','web','read','weather_forecast'],['OpenAlex','web','read','openalex_search'],['Web Fetch','web','read','web_fetch'],['Web Eval','web','read','web_eval'],['Web Semantic Tree','web','read','web_semantic_tree'],['Visual Output','media','read','moli_screenshot'],['Browser','web','external_side_effect','browser_session'],['Images','media','read',null],['Video','media','read',null],['Audio','media','read',null],['Transcribe','media','read',null],['Slides','documents','write','publish_slides'],['Maps','web','read',null],
];
const present=v=>typeof v==='string'&&v.trim().length>0;
const executable=p=>{try{accessSync(p,constants.X_OK);return true}catch{return false}};
export function buildCapabilityManifest({enabled=[],openAlexApiKey,exaApiKey,userAgent,browserProvider,browserPath,moliPath=process.env.MOLI_PATH||'/home/ubuntu/.local/bin/moli'}={}){
 const chosen=new Set(Array.isArray(enabled)?enabled:[]),moli=executable(moliPath),weather=present(userAgent),openalex=present(openAlexApiKey);
 const browser=browserConfiguration({provider:browserProvider || 'moli',binaryPath:browserPath || moliPath});
 const exaConfigured=createExaTools({apiKey:exaApiKey,enabled:['Search','Find Similar']}).capabilities[0].configured;
 const capabilities=BASE.map(([label,category,effect,tool])=>{
  const implemented=tool!==null;
  let configured=implemented;
  if(label==='Browser')configured=browser.configured;
  if(label==='OpenAlex')configured=openalex;
  if(['Search','Find Similar'].includes(label))configured=exaConfigured;
  if(label==='Weather')configured=weather;
  if(['Web Fetch','Web Semantic Tree','Visual Output','Web Eval'].includes(label))configured=moli;
  const authorized=chosen.size?chosen.has(label):implemented&&configured;
  const executor=implemented&&configured?{kind:'tool',name:tool}:{kind:'none',reason:implemented?'Required configuration is missing':'No executor is installed'};
  const executable=implemented&&configured&&authorized&&executor.kind!=='none';
  return {...(label==='Browser'?{provider:browser.provider,details:browser.reason}:{}),id:'capability.'+label.toLowerCase().replace(/[^a-z0-9]+/g,'_'),label,category,implemented,configured,authorized,effect,executor,executable,surfaces:{composer:implemented&&configured,marketplace:true,toolCatalog:implemented&&configured},...(executor.kind==='none'?{reason:executor.reason}:{})};
 });
 return {version:1,capabilities};
}
export const capabilityEffect=effect=>EFFECTS.has(effect)?effect:'read';
