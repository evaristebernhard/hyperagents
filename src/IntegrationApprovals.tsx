import {useEffect,useRef,useState} from "react";
import type {IntegrationApproval} from "./types";
import {useWorkspace} from "./workspace";
import {api} from "./backend-client";
import {Modal} from "./ui";
export default function IntegrationApprovals({threadId,messageId,requests}:{threadId:string;messageId:string;requests:IntegrationApproval[]}){
 const w=useWorkspace(),[review,setReview]=useState<IntegrationApproval|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const mounted=useRef(true),scope=useRef(w.state.active);scope.current=w.state.active;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;}},[]);
 const update=(id:string,status:IntegrationApproval["status"],result?:string)=>w.set("threads",threads=>threads.map(thread=>thread.id!==threadId?thread:{...thread,messages:thread.messages?.map(message=>message.id!==messageId?message:{...message,text:status==="completed"&&!message.actionRequests?.some(a=>a.id===id&&a.status==="completed")?message.text+"\n\n[Confirmed integration result]\n"+result:message.text,actionRequests:message.actionRequests?.map(action=>action.id===id?{...action,status,...(result?{result}:{})}:action)})}));
 async function execute(){
  if(!review||busy)return;const action=review,workspaceId=w.state.active;setBusy(true);setError("");
  try{
   await w.flush();if(!mounted.current||scope.current!==workspaceId)return;
   const reply=await api<{id:string;status:string;result:unknown}>("/api/integrations/execute",{method:"POST",body:{token:action.token,confirmed:true,workspaceId,threadId}});
   if(!mounted.current||scope.current!==workspaceId)return;
   if(reply.status!=="completed"||reply.id!==action.id)throw Error("The service did not confirm completion.");
   const result=JSON.stringify(reply.result,null,2).slice(0,12000);update(action.id,"completed",result);await w.flush();setReview(null);
  }catch(e){if(mounted.current&&scope.current===workspaceId){const text=e instanceof Error?e.message:"Action failed or result is unknown.";setError(text);setReview({...action,status:"failed"});update(action.id,"failed",text);await w.flush().catch(()=>{});}}
  finally{if(mounted.current&&scope.current===workspaceId)setBusy(false);}
 }
 return <div className="rt-approvals" aria-label="Integration action approvals">{requests.map(action=><article className={"rt-approval "+action.status} key={action.id}><strong>{action.provider} · {action.operation}</strong><p>{action.status==="pending"?"Awaiting your confirmation — nothing has been sent or written.":action.status==="completed"?"Confirmed action completed.":action.status==="dismissed"?"Proposal dismissed in this conversation.":"Failed or result unconfirmed. Verify the external service before requesting another action."}</p><details><summary>Exact action details</summary><pre>{JSON.stringify(action.args,null,2)}</pre></details>{action.result&&<details><summary>Result</summary><pre>{action.result}</pre></details>}{action.status==="pending"&&<div className="rt-actions"><button className="btn small primary" disabled={busy} onClick={()=>{setReview(action);setError("");}}>Review and execute</button><button className="btn small" disabled={busy} onClick={async()=>{update(action.id,"dismissed");await w.flush().catch(e=>setError(e.message));}}>Dismiss proposal</button></div>}</article>)}{error&&!review&&<p role="alert" className="rt-error">{error}</p>}{review&&<Modal title="Confirm external write" onClose={()=>{if(!busy)setReview(null);}}><p>This will perform the following action using the connected account. Review the destination and full content. No action is sent before you click Confirm write.</p><h3>{review.provider} · {review.operation}</h3><pre className="rt-approval-details">{JSON.stringify(review.args,null,2)}</pre>{error&&<p className="rt-error" role="alert">{error}</p>}<div className="rt-actions"><button className="btn" disabled={busy} onClick={()=>setReview(null)}>Cancel</button><button className="btn primary" disabled={busy||review.status!=="pending"} onClick={()=>void execute()}>{busy?"Executing once…":"Confirm write"}</button></div></Modal>}</div>;
}
