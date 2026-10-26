/** Real locked app-server, local controlled Responses, actual scoped Run messages. */
import http from 'node:http';
import path from 'node:path';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { initializeProfileFromDefault,runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { nativeCodexPackage } from '../src/agent/native-codex.js';
import { PersistentCodexProvider } from '../src/agent/codex-provider.js';
import { RiftStore } from '../src/storage/database.js';
import { createWorkspace } from '../src/project/workspace.js';
import { configureRoles } from '../src/project/agent-roles.js';
import { CollaborationService } from '../src/chat/collaboration.js';
import type { TaskCoordinator } from '../src/task/coordinator.js';
import type { ActivationHandle } from '../src/contracts/index.js';
import type { RuntimeTool } from '../src/agent/runtime-types.js';
import { publicError } from '../src/api/security.js';

const root=path.resolve('.runtime-evidence');await mkdir(root,{recursive:true});
const temporary=await mkdtemp(path.join(root,'collaboration-native-')),runtimeHome=path.join(temporary,'codex');await mkdir(runtimeHome);
const requests:{input:string;tools:unknown;keys:string[];toolContext:boolean}[]=[];let recipientAgentId='';
const server=http.createServer(async(req,res)=>{
  try{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push({input:JSON.stringify(body.input??[]),tools:body.tools,keys:Object.keys(body),toolContext:JSON.stringify(body).includes('rift_send_message')});
    const n=requests.length,attempt=Math.ceil(n/2);
    const item=n%2===1?{type:'function_call',id:`fc_${n}`,call_id:`call_${n}`,name:'rift_send_message',arguments:JSON.stringify({recipientAgentId,content:`CONTROLLED_RUN_${attempt}_PROGRESS`,kind:'progress',idempotencyKey:'probe-progress'})}:{type:'message',id:`msg_${n}`,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:`CONTROLLED_RUN_${attempt}_COMPLETE`,annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const send=(type:string,value:object)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
    send('response.created',{response:{id:`response_${n}`,status:'in_progress',output:[]}});send('response.output_item.added',{output_index:0,item});send('response.output_item.done',{output_index:0,item});send('response.completed',{response:{id:`response_${n}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  }catch{res.writeHead(500);res.end();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=(server.address() as import('node:net').AddressInfo).port;
process.env.DSH_HOME=path.join(temporary,'dsh');process.env.RIFT_HOME=path.join(temporary,'rift');process.env.RIFT_PORT='0';
initializeProfileFromDefault('collaboration-probe','sdk-minimal',process.env.DSH_HOME);
const report:Record<string,unknown>={date:new Date().toISOString(),payload:nativeCodexPackage().version,mode:'real pinned app-server; local controlled Responses; no external inference'};
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('collaboration-probe'),profile:'collaboration-probe',patchFiles:[path.resolve('profiles/rift.patch.yml')],args:[]});
const modelProvider={id:'rift_collaboration_probe',config:{name:'RIFT controlled collaboration',base_url:`http://127.0.0.1:${port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0,stream_idle_timeout_ms:10000}};
let store:RiftStore|undefined,collaboration:CollaborationService|undefined,handle:ActivationHandle|undefined;
try{
  store=new RiftStore(path.join(temporary,'ledger.db'));
  const workspace=createWorkspace(store,{id:'workspace',name:'Collaboration probe',rootPath:temporary,repositoryPath:temporary,commonGitDir:path.join(temporary,'.git'),baseRef:'HEAD'});
  const binding={id:'codex',providerName:'codex-probe',packageVersion:'probe',configRevision:1,capabilities:{},credentialRefs:['native:codex']};
  const roles=configureRoles(store,workspace.id,[binding],[{name:'lead',purpose:'lead',kind:'dsh-lead',prompt:'Coordinate.',revision:1},{name:'developer',purpose:'developer',kind:'subagent',providerBindingId:binding.id,prompt:'Use only requested tools.',revision:1},{name:'reviewer',purpose:'reviewer',kind:'subagent',providerBindingId:binding.id,prompt:'Review read-only.',revision:1}],new Set(['codex-probe']));
  const lead=roles.find(role=>role.purpose==='lead')!,developer=roles.find(role=>role.purpose==='developer')!,reviewer=roles.find(role=>role.purpose==='reviewer')!;recipientAgentId=lead.id;
  store.exec("INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('conversation','workspace','Probe','now')");
  store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow','workspace','probe','running','ref','base')");
  store.exec("INSERT INTO tasks(id,workflow_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES('task','workflow','change','probe','probe','[]','[]','running')");
  collaboration=new CollaborationService(store,{} as TaskCoordinator,{enqueueMessage(){throw new Error('Progress must not create another Turn.');}});
  const provider=new PersistentCodexProvider({providerName:'codex-probe',model:'gpt-6.1-sol',env:{CODEX_HOME:runtimeHome}},spec=>ctx.subprocess.spawn(spec),modelProvider);
  const threads:string[]=[];let firstTool:RuntimeTool|undefined;
  for(let attempt=1;attempt<=3;attempt++){
    const cwd=path.join(temporary,`attempt-${attempt}`);await mkdir(cwd);
    const role=attempt===3?reviewer:developer,purpose=attempt===1?'develop':attempt===2?'repair':'review',runId=`run-${attempt}`;
    store.exec('INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?)',runId,'task',role.id,purpose,attempt,'running',JSON.stringify({role,binding}),'later','now');
    const run=store.run(runId),tools=collaboration.runTools(run);if(attempt===1)firstTool=tools[0];
    if(attempt===2){
      // Controlled fixture message; actual Host inbox capture/accept machinery
      // delivers this durable input into the fresh repair native thread.
      store.exec("INSERT INTO messages(id,workspace_id,conversation_id,role,content,status,created_at,sender_type,sender_agent_id,recipient_agent_id,kind,origin,workflow_id,task_id) VALUES('repair-input','workspace','conversation','assistant','HOST_REPAIR_INBOX_SENTINEL','completed','now','agent',?,?,'discussion','model','workflow','task')",lead.id,developer.id);
      store.exec("INSERT INTO agent_inbox(id,message_id,workspace_id,conversation_id,recipient_agent_id,task_id,scope,status,created_at) VALUES('repair-inbox','repair-input','workspace','conversation',?,'task','task','pending','now')",developer.id);
    }
    const collaborationMessages=collaboration.captureRunInbox(run),previousResults=attempt===2?store.all('SELECT id,result FROM runs WHERE task_id=? AND id<>? AND result IS NOT NULL','task',runId):[];
    handle=await provider.startTask(store,{run,task:store.task('task'),role,cwd,prompt:JSON.stringify({runId,cwd,previousResults,collaborationMessages,instructions:attempt===1?'Remember COLLAB_TASK_MEMORY. Send one progress message to the Lead.':'Send one progress message to the Lead using the current Run and Host input evidence.'}),signal:AbortSignal.timeout(60000),tools,onAccepted:()=>collaboration!.acceptRunInbox(run.id)});
    const output=await handle.result;await handle.dispose();handle=undefined;
    threads.push(store.require<{threadId:string}>('SELECT s.thread_id FROM native_sessions s JOIN native_executions e ON e.session_id=s.id WHERE e.execution_id=?',runId).threadId);
    store.exec("UPDATE runs SET result=?,status='succeeded',cleanup_status='confirmed',slot_released_at='now' WHERE id=?",JSON.stringify({text:output.text,stopReason:output.stopReason}),runId);
  }
  let staleRejected=false;try{await firstTool!.execute({recipientAgentId,kind:'progress',content:'STALE_MESSAGE',idempotencyKey:'stale'},new AbortController().signal);}catch(error){staleRejected=(error as {code?:string}).code==='UNAUTHORIZED';}
  const messages=store.all<{runId:string;senderAgentId:string;content:string;senderType:string}>('SELECT run_id,sender_agent_id,content,sender_type FROM messages WHERE run_id IS NOT NULL ORDER BY rowid');
  const permissionUpdates=JSON.parse(requests[2]!.input).filter((item:{role?:string})=>item.role==='developer').flatMap((item:{content?:{text?:string}[]})=>item.content??[]).map((item:{text?:string})=>item.text??'').filter((text:string)=>text.includes('<permissions instructions>')) as string[];
  // The pinned provider serializes tool declarations into its prompt rather
  // than a top-level Responses tools field. Check the declaration itself.
  const restoredDeclarations=requests[2]!.input;
  const declarationStart=restoredDeclarations.indexOf('### `rift_send_message`');
  report.restoredDeclaration=declarationStart<0?null:restoredDeclarations.slice(declarationStart,restoredDeclarations.indexOf('### ',declarationStart+4));
  const checks={changedWorktreeChangesThread:threads[0]!==threads[1],reviewIndependent:threads[2]!==threads[0],oldNativeHistoryExcluded:!requests[2]!.input.includes('COLLAB_TASK_MEMORY'),reviewIsolated:!requests[4]!.input.includes('COLLAB_TASK_MEMORY'),repairCwdUpdated:(permissionUpdates.at(-1)??'').includes('attempt-2')&&!(permissionUpdates.at(-1)??'').includes('attempt-1'),freshToolDeclaration:declarationStart>=0&&/rift_send_message\(args:[\s\S]{0,600}recipientAgentId/.test(restoredDeclarations),freshRunClosures:JSON.stringify(messages.map(message=>message.runId))===JSON.stringify(['run-1','run-2','run-3']),authorship:messages[0]?.senderAgentId===developer.id&&messages[1]?.senderAgentId===developer.id&&messages[2]?.senderAgentId===reviewer.id,staleRejected,noSecondSenderLease:store.all("SELECT id FROM execution_leases WHERE owner_type='turn'").length===0,noDiscussionTurns:store.all('SELECT id FROM agent_turns').length===0};
  report.permissionContract='A changed task worktree starts a fresh native thread. Host task envelopes supply durable prior results and source evidence; stale native paths and authority are not restored.';
  const evidenceChecks={hostPriorResultInjected:requests[2]!.input.includes('CONTROLLED_RUN_1_COMPLETE'),hostTaskInboxInjected:requests[2]!.input.includes('HOST_REPAIR_INBOX_SENTINEL'),hostTaskInboxAccepted:!!store.get("SELECT run_id FROM run_inbox_receipts WHERE run_id='run-2' AND message_id='repair-input' AND status='accepted'")&&!!store.get("SELECT id FROM agent_inbox WHERE id='repair-inbox' AND status='consumed' AND execution_id='run-2'")};
  report.checks={...checks,...evidenceChecks};report.messages=messages;report.httpCalls=requests.length;report.status=Object.values({...checks,...evidenceChecks}).every(Boolean)?'pass':'fail';
}catch(error){report.status='fail';report.error=publicError(error);report.httpCalls=requests.length;}
finally{
  if(handle)await handle.dispose().catch(error=>{report.cleanupError=publicError(error);});collaboration?.close();store?.close();await shutdown.shutdown(0);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  await writeFile(path.resolve('docs/evidence/collaboration-native-probe.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.status!=='pass')process.exitCode=1;
}
