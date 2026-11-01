import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreeSearchTools } from './free-search.mjs';
const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>Search</title>${items}</channel></rss>`;
const item = (url = 'https://www.openai.com/a?x=1&amp;y=2', title = 'A &amp; B', desc = '<![CDATA[Real <b>text</b> & words]]>') => `<item><title>${title}</title><link>${url}</link><description>${desc}</description></item>`;
const make = (xml = rss(item()), options = {}) => createFreeSearchTools({ fetchImpl: async () => new Response(xml), ...options });
const run = adapter => adapter.execute('web_search', { query: 'test' });
const rejects = (p, code) => assert.rejects(p, e => e.code === code);
test('keyless Search catalog, fixed endpoint, safe GET configuration and real RSS projection', async () => {
 let calls=0;
 const adapter = createFreeSearchTools({ fetchImpl: async (url, options) => {
  calls++; const u=new URL(url); assert.equal(u.origin,'https://cn.bing.com'); assert.equal(u.pathname,'/search'); assert.equal(u.searchParams.get('q'),'test'); assert.equal(u.searchParams.get('format'),'rss');
  assert.equal(options.redirect,'manual'); assert.equal(options.credentials,'omit'); assert.equal(options.method,'GET'); assert.equal(options.headers.Authorization,undefined); return new Response(rss(item()));
 }});
 assert.equal(adapter.definitions[0].function.name,'web_search'); assert.equal(adapter.capabilities[0].configured,true);
 assert.deepEqual(await run(adapter), {status:'ok',provider:'public-bing-rss',query:'test',results:[{title:'A & B',url:'https://www.openai.com/a?x=1&y=2',excerpt:'Real <b>text</b> & words'}],truncated:false}); assert.equal(calls,1);
});
test('genuine valid empty RSS is an empty success; HTML block is not', async()=>{
 assert.deepEqual((await run(make(rss('')))).results,[]); await rejects(run(make('<html>blocked</html>')),'INVALID_RESPONSE');
});
test('bounds result count and text; numeric entities and normalized URL', async()=>{
 const r=await make(rss(item('HTTPS://WWW.OPENAI.COM:443/','&#65;'.repeat(600),'hello&nbsp;world')+item())).execute('web_search',{query:' x ',numResults:1});
 assert.equal(r.results.length,1); assert.equal(r.results[0].title.length,500); assert.equal(r.results[0].url,'https://www.openai.com/'); assert.equal(r.truncated,true); assert.equal(r.query,'x');
});
test('reject extra args, controls, invalid limits and accessors before transport',async()=>{
 let calls=0; const a=make('',{fetchImpl:()=>{calls++;throw Error('must not run');}});
 for(const args of [{query:'x',url:'https://evil.com'}, {query:'x\n'}, {query:'x'.repeat(501)}, {query:' '}, {query:'x',numResults:0}, {query:'x',numResults:11}, {query:'x',numResults:1.5}, {query:'x',numResults:undefined}, [], Object.defineProperty({},'query',{get(){throw Error('getter');}})]) await rejects(a.execute('web_search',args),'INVALID_ARGUMENTS');
 assert.equal(calls,0);
});
test('disabled/unauthorized/unknown function never executes',async()=>{
 for(const a of [make('',{disabled:true}),make('',{enabled:[]})]) {assert.equal(a.definitions.length,0);await rejects(run(a),'UNAVAILABLE');}
 await rejects(make().execute('exa_find_similar',{query:'x'}),'UNAVAILABLE');
});
test('redirects, changed origin and rate limiting fail explicitly without retry',async()=>{
 let calls=0;
 for(const response of [new Response('',{status:302,headers:{location:'http://127.0.0.1'}}),{status:200,redirected:true},{status:200,url:'https://evil.com/'},new Response('sensitive upstream body',{status:429})]) {
  const a=make('',{fetchImpl:async()=>{calls++;return response;}}); await rejects(run(a),response.status===429?'UPSTREAM_HTTP':'REDIRECT_BLOCKED');
 } assert.equal(calls,4);
});
test('unsafe XML, malformed document, declarations and unsafe links rejected',async()=>{
 for(const xml of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+rss(item()),rss(item()).replace('A &amp; B','&unknown;'),rss(item()).replace('</item>','</wrong>'),rss(item()).slice(0,-1),rss(item())+'<rss/>',rss('<item><title>x</title></item>'),rss(item()).replace('A &amp; B','raw & broken'),rss(item()).replace('A &amp; B','&#0;')]) await rejects(run(make(xml)),'INVALID_RESPONSE');
 for(const url of ['javascript:alert(1)','data:text/plain,x','file:///etc/passwd','https://user:pass@openai.com','https://127.0.0.1/','http://2130706433/','http://[::1]/','https://localhost/','https://foo.internal/','https://openai.com:444/','https://openai.com/%0afoo','https://openai.com\\@evil.com/']) await rejects(run(make(rss(item(url)))),'INVALID_RESPONSE');
});
test('oversized header and streamed body rejected',async()=>{
 await rejects(run(make('',{fetchImpl:async()=>new Response('',{headers:{'content-length':String(128*1024+1)}})})),'RESPONSE_TOO_LARGE');
 await rejects(run(make('x'.repeat(128*1024+1))),'RESPONSE_TOO_LARGE');
});
test('timeout covers transport and stalled body even if transport ignores signal',async()=>{
 await rejects(run(make('',{timeoutMs:15,fetchImpl:()=>new Promise(()=>{})})),'TIMEOUT');
 let cancelled=false;
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('<rss>'));},cancel(){cancelled=true;}});
 await rejects(run(make('',{timeoutMs:15,fetchImpl:async()=>new Response(body)})),'TIMEOUT'); assert.equal(cancelled,true);
});
test('abort before request and during stalled body',async()=>{
 const c=new AbortController();c.abort();await rejects(make().execute('web_search',{query:'x'},c.signal),'CANCELLED');
 const d=new AbortController(),a=make('',{fetchImpl:async()=>new Response(new ReadableStream({start(){setTimeout(()=>d.abort(),10);}}))});
 await rejects(a.execute('web_search',{query:'x'},d.signal),'CANCELLED');
});
test('network exception details never leak',async()=>{
 await assert.rejects(run(make('',{fetchImpl:()=>{throw Error('secret-local-path-token');}})),e=>e.code==='NETWORK_ERROR'&&!e.message.includes('secret'));
});
