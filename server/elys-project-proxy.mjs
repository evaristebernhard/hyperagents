import http from 'node:http';
import {createHash} from 'node:crypto';
import {ApiError} from './validation.mjs';

const ports={'user-lin':3101,'user-man':3102,'user-shan':3103};
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const hop=new Set(['host','connection','keep-alive','transfer-encoding','upgrade','proxy-authorization','proxy-authenticate','te','trailer','cookie','authorization','x-csrf-token','accept-encoding']);

// Called only after the normal owner session / Origin / CSRF gates. Targets are
// fixed local Elys identities, never an endpoint supplied in workspace data.
export function createElysProjectProxy({load,targets=Object.fromEntries(Object.entries(ports).map(([id,port])=>[id,`http://127.0.0.1:${port}`]))}) {
  return async function handle(req,res){
    const url=new URL(req.url,'http://workspace.local');
    const match=url.pathname.match(/^\/api\/project-apps\/elys\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/);
    if(!match)throw new ApiError(404,'Elys project route not found.','ELYS_PROJECT');
    const [,workspaceId,projectId,userId,suffix]=match;
    if(!valid(workspaceId)||!valid(projectId)||!Object.hasOwn(ports,userId)||suffix.startsWith('/')||/[\x00-\x1f\\]/.test(suffix)||/%(?:2e|2f|5c)/i.test(suffix)||suffix.split('/').includes('..'))throw new ApiError(400,'Invalid Elys project path.','ELYS_PROJECT');
    const workspace=load().state.workspaces.find(w=>w.id===workspaceId&&!w.archived);
    const project=workspace?.data.projects.find(p=>p.id===projectId&&!p.archived&&p.application==='elys');
    if(!project)throw new ApiError(404,'Elys is not attached to this workspace project.','ELYS_PROJECT');
    const target=new URL(targets[userId]);
    if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.pathname!=='/'||target.username||target.password||target.search||target.hash)throw Error('Elys target must be a fixed loopback origin');
    const prefix=`/api/project-apps/elys/${workspaceId}/${projectId}/${userId}/`;
    const cookiePrefix='ep_'+createHash('sha256').update(prefix).digest('hex').slice(0,20)+'_';
    const headers=Object.fromEntries(Object.entries(req.headers).filter(([key])=>!hop.has(key.toLowerCase())));
    headers.host=target.host;
    if(req.headers.origin)headers.origin=target.origin;
    const cookies=String(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookiePrefix)).map(s=>s.slice(cookiePrefix.length));
    if(cookies.length)headers.cookie=cookies.join('; ');
    const upstreamUrl=new URL(target);upstreamUrl.pathname='/'+suffix;upstreamUrl.search=url.search;
    await new Promise((resolve,reject)=>{
      let settled=false;
      const done=error=>{if(settled)return;settled=true;req.removeListener('aborted',abort);error?reject(error):resolve();};
      const upstream=http.request(upstreamUrl,{method:req.method,headers},incoming=>{
        const html=String(incoming.headers['content-type']||'').includes('text/html');
        const outgoing=Object.fromEntries(Object.entries(incoming.headers).filter(([key])=>!['connection','transfer-encoding','set-cookie','content-length','x-frame-options','content-security-policy'].includes(key)&&!(html&&key==='content-encoding')));
        outgoing['cache-control']='no-store';outgoing['x-frame-options']='SAMEORIGIN';outgoing['content-security-policy']="frame-ancestors 'self'";
        if(incoming.headers['set-cookie'])outgoing['set-cookie']=incoming.headers['set-cookie'].map(value=>cookiePrefix+value.replace(/;\s*path=[^;]*/ig,'').replace(/;\s*domain=[^;]*/ig,'')+`; Path=${prefix}`);
        if(outgoing.location){const location=new URL(outgoing.location,upstreamUrl);if(location.origin!==target.origin){incoming.resume();upstream.destroy();return done(new ApiError(502,'Elys attempted an unsupported redirect.','ELYS_PROJECT'));}outgoing.location=prefix+location.pathname.slice(1)+location.search+location.hash;}
        if(html){
          if(incoming.headers['content-encoding']&&!['identity'].includes(incoming.headers['content-encoding'])){incoming.resume();return done(new ApiError(502,'Elys returned unsupported encoded HTML.','ELYS_PROJECT'));}
          let body='';incoming.setEncoding('utf8');incoming.on('data',part=>{body+=part;if(body.length>2*1024*1024)upstream.destroy(Error('Elys HTML exceeds limit'));});
          incoming.on('end',()=>{body=body.replace(/((?:src|href|action)\s*=\s*['"])\/(?!\/)/gi,'$1'+prefix);res.writeHead(incoming.statusCode||502,outgoing);res.end(req.method==='HEAD'?undefined:body);done();});
        }else{res.writeHead(incoming.statusCode||502,outgoing);incoming.pipe(res);incoming.on('end',()=>done());}
        incoming.on('error',()=>done(new ApiError(502,'Elys connection interrupted.','ELYS_PROJECT')));
      });
      const abort=()=>upstream.destroy();req.once('aborted',abort);
      upstream.setTimeout(120000,()=>upstream.destroy(Error('Elys timed out')));
      upstream.on('error',()=>done(new ApiError(503,'Elys子项目服务暂时不可达，请重试。','ELYS_UNAVAILABLE')));
      req.pipe(upstream);
    });
  };
}
