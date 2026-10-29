import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const MAX_PAGE=12000,MAX_TOTAL=1024*1024;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const fail=m=>{throw new Error(m)};
export function createResourceReadAdapter({workspaceId,resolve}){
 const secret=randomBytes(32);
 const sign=body=>createHmac('sha256',secret).update(body).digest('base64url');
 const encode=p=>{const body=JSON.stringify(p),sig=sign(body);return Buffer.from(body).toString('base64url')+'.'+sig};
 const decode=token=>{if(typeof token!=='string'||token.length>2048)fail('Invalid read cursor.');const [a,b]=token.split('.');if(!a||!b)fail('Invalid read cursor.');const body=Buffer.from(a,'base64url'),expected=sign(body.toString());const actual=Buffer.from(b),want=Buffer.from(expected);if(actual.length!==want.length||!timingSafeEqual(actual,want))fail('Invalid read cursor.');let p;try{p=JSON.parse(body.toString())}catch{fail('Invalid read cursor.');}return p};
 return {async resource_read_page(args){if(!plain(args)||typeof args.type!=='string'||typeof args.id!=='string')fail('Invalid paged read arguments.');const limit=args.byteLimit===undefined?MAX_PAGE:args.byteLimit;if(!Number.isInteger(limit)||limit<1024||limit>MAX_PAGE)fail('Invalid page size.');let start=args.byteStart===undefined?0:args.byteStart;if(!Number.isSafeInteger(start)||start<0)fail('Invalid page offset.');if(args.cursor){const p=decode(args.cursor);if(p.workspaceId!==workspaceId||p.type!==args.type||p.id!==args.id)fail('Cursor does not match this resource.');start=p.offset;}
 const value=await resolve(args.type,args.id);if(!value||typeof value.content!=='string')fail('Resource is not readable text.');const buf=Buffer.from(value.content,'utf8');if(start>buf.length)fail('Page offset exceeds resource.');if(start>0)while(start<buf.length&&(buf[start]&0xc0)===0x80)start++;let end=Math.min(buf.length,start+limit);while(end>start&&end<buf.length&&(buf[end]&0xc0)===0x80)end--;const text=buf.subarray(start,end).toString('utf8');const nextOffset=end<buf.length?end:undefined;return {status:'ok',type:args.type,id:args.id,content:text,byteStart:start,byteLength:Buffer.byteLength(text),totalBytes:buf.length,truncated:!!nextOffset,...(nextOffset===undefined?{}:{nextOffset,nextCursor:encode({workspaceId,type:args.type,id:args.id,offset:nextOffset})})};}};
}
export const RESOURCE_READ_PAGE_LIMITS=Object.freeze({maxPage:MAX_PAGE,maxTotal:MAX_TOTAL});
