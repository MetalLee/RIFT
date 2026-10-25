/** Real pinned app-server + local Responses fixture. No external inference. */
import http from 'node:http';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { NativeCodexRuntime, nativeCodexPackage } from '../src/agent/native-codex.js';
import { PersistentCodexProvider } from '../src/agent/codex-provider.js';
import { RiftStore } from '../src/storage/database.js';
import { createWorkspace } from '../src/project/workspace.js';
import { configureRoles } from '../src/project/agent-roles.js';
import { publicError } from '../src/api/security.js';
import type { RuntimeHandle, RuntimeSession } from '../src/agent/runtime-types.js';
import type { ActivationHandle } from '../src/contracts/index.js';

const root=path.resolve('.runtime-evidence');await mkdir(root,{recursive:true});
const temporary=await mkdtemp(path.join(root,'native-session-'));
const runtimeHome=path.join(temporary,'codex');await mkdir(runtimeHome);
const requests:{input:string;tools:unknown}[]=[];
const server=http.createServer(async(req,res)=>{
  try {
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({input:JSON.stringify(body.input??[]),tools:body.tools});
    const n=requests.length;
    const item=n<=4&&n%2===1?{type:'function_call',id:`fc_${n}`,call_id:`call_${n}`,name:'rift_probe',arguments:'{}'}:
      {type:'message',id:`msg_${n}`,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:n<=4?`RIFT_SESSION_REPLY_${n}`:JSON.stringify({schemaVersion:1,taskId:'task',runId:`run-${n}`,outcome:'completed',summary:'Protocol probe only',changedPaths:[],checksClaimed:[],blockingReasons:[]}),annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const send=(type:string,value:object)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
    send('response.created',{response:{id:`r_${n}`,status:'in_progress',output:[]}});
    send('response.output_item.added',{output_index:0,item});send('response.output_item.done',{output_index:0,item});
    send('response.completed',{response:{id:`r_${n}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  }catch{res.writeHead(500);res.end();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=(server.address() as import('node:net').AddressInfo).port;
process.env.DSH_HOME=path.join(temporary,'dsh');process.env.RIFT_HOME=path.join(temporary,'rift');process.env.RIFT_PORT='0';
initializeProfileFromDefault('native-session','sdk-minimal',process.env.DSH_HOME);
const report:Record<string,unknown>={date:new Date().toISOString(),payload:nativeCodexPackage().version,mode:'real app-server; local controlled Responses endpoint; no external model calls'};
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('native-session'),profile:'native-session',patchFiles:[path.resolve('profiles/rift.patch.yml')],args:[]});
const modelProvider={id:'rift_session_probe',config:{name:'RIFT local session probe',base_url:`http://127.0.0.1:${port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0,stream_idle_timeout_ms:10000}};
let handle:RuntimeHandle|ActivationHandle|undefined,store:RiftStore|undefined;
try {
  let threadId:string|undefined;const turns:string[]=[];let firstCalls=0,secondCalls=0,processes=0;
  const spawn=(spec:Parameters<typeof ctx.subprocess.spawn>[0])=>{processes++;return ctx.subprocess.spawn(spec);};
  const session=():RuntimeSession=>({threadId,runtimeHome,onThread(value){threadId=value;},onTurn(value){turns.push(value);},onSettled(){}});
  const runtime=()=>new NativeCodexRuntime({spawn,modelProvider});
  const common={workspaceId:'probe',agentId:'lead',cwd:temporary,model:'gpt-6.1-sol',instructions:'Call rift_probe, then answer.',signal:AbortSignal.timeout(60000)};
  const tool=(execute:()=>Promise<unknown>)=>({name:'rift_probe',description:'Local no-effect probe.',inputSchema:{type:'object',properties:{},additionalProperties:false},execute});
  handle=await runtime().start({...common,turnId:'first',session:session(),messages:[{role:'user',content:'Remember RIFT_MEMORY_SENTINEL. Call rift_probe.'}],tools:[tool(async()=>{firstCalls++;return{value:'FIRST_CLOSURE'};})]});
  await handle.result;await handle.dispose();handle=undefined;const originalThread=threadId;
  handle=await runtime().start({...common,turnId:'second',session:session(),messages:[{role:'user',content:'Call rift_probe again and continue.'}],tools:[tool(async()=>{secondCalls++;return{value:'SECOND_CLOSURE'};})]});
  await handle.result;await handle.dispose();handle=undefined;
  report.chat={sameThread:threadId===originalThread,distinctTurns:turns.length===2&&turns[0]!==turns[1],firstCalls,secondCalls,historyRestored:requests[2]?.input.includes('RIFT_MEMORY_SENTINEL')&&requests[2]?.input.includes('RIFT_SESSION_REPLY_2'),freshClosureObserved:requests[3]?.input.includes('SECOND_CLOSURE')};

  const file=path.join(temporary,'task-ledger.db');store=new RiftStore(file);
  const workspace=createWorkspace(store,{id:'workspace',name:'probe',rootPath:temporary,repositoryPath:temporary,commonGitDir:path.join(temporary,'.git'),baseRef:'HEAD'});
  const binding={id:'codex',providerName:'codex-probe',packageVersion:'probe',configRevision:1,capabilities:{},credentialRefs:['native:codex']};
  const roles=configureRoles(store,workspace.id,[binding],[{name:'lead',kind:'dsh-lead',purpose:'lead',prompt:'Coordinate.',revision:1},{name:'developer-a',kind:'subagent',purpose:'developer',providerBindingId:'codex',prompt:'Return the requested JSON.',revision:1},{name:'reviewer',kind:'subagent',purpose:'reviewer',providerBindingId:'codex',prompt:'Review read-only.',revision:1}],new Set(['codex-probe']));
  const developer=roles.find(role=>role.purpose==='developer')!,reviewer=roles.find(role=>role.purpose==='reviewer')!;
  store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('workflow','workspace','probe','running','ref','base')");
  store.exec("INSERT INTO tasks(id,workflow_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES('task','workflow','change','probe','probe','[]','[]','running')");
  const provider=new PersistentCodexProvider({providerName:'codex-probe',model:'gpt-6.1-sol',env:{CODEX_HOME:runtimeHome}},spawn,modelProvider);
  const taskThreads:string[]=[];
  for(let attempt=1;attempt<=3;attempt++){
    const cwd=path.join(temporary,`attempt-${attempt}`);await mkdir(cwd);
    const role=attempt===3?reviewer:developer,purpose=attempt===1?'develop':attempt===2?'repair':'review',runId=`run-${attempt}`;
    store.exec('INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?)',runId,'task',role.id,purpose,attempt,'running',JSON.stringify({role,binding}),'later','now');
    handle=await provider.startTask(store,{run:store.run(runId),task:store.task('task'),role,cwd,prompt:JSON.stringify({runId,cwd,instructions:attempt===1?'Remember TASK_MEMORY_SENTINEL.':'Use current cwd; continue with new evidence.'}),signal:AbortSignal.timeout(60000)});
    await handle.result;await handle.dispose();handle=undefined;
    taskThreads.push(store.require<{threadId:string}>('SELECT s.thread_id FROM native_sessions s JOIN native_executions e ON e.session_id=s.id WHERE e.execution_id=?',runId).threadId);
    store.exec("UPDATE runs SET cleanup_status='confirmed',slot_released_at='now' WHERE id=?",runId);
    if(attempt===1){store.close();store=new RiftStore(file);}
  }
  const permissionUpdates=JSON.parse(requests[5]!.input).filter((item:{role?:string})=>item.role==='developer').flatMap((item:{content?:{text?:string}[]})=>item.content??[]).map((item:{text?:string})=>item.text??'').filter((text:string)=>text.includes('<permissions instructions>')) as string[];
  const currentPermissions=permissionUpdates.at(-1)??'';
  report.tasks={repairSameThread:taskThreads[0]===taskThreads[1],reviewIndependent:taskThreads[2]!==taskThreads[0],repairHistoryRestored:requests[5]?.input.includes('TASK_MEMORY_SENTINEL'),reviewDoesNotInheritDeveloper:!requests[6]?.input.includes('TASK_MEMORY_SENTINEL'),repairNewCwd:currentPermissions.includes('attempt-2')&&!currentPermissions.includes('attempt-1'),executions:store.all('SELECT execution_id,native_turn_id,status FROM native_executions')};
  const chat=report.chat as Record<string,unknown>,tasks=report.tasks as Record<string,unknown>;
  report.processes=processes;report.httpCalls=requests.length;
  report.status=chat.sameThread&&chat.distinctTurns&&firstCalls===1&&secondCalls===1&&chat.historyRestored&&chat.freshClosureObserved&&tasks.repairSameThread&&tasks.reviewIndependent&&tasks.repairHistoryRestored&&tasks.reviewDoesNotInheritDeveloper&&tasks.repairNewCwd?'pass':'fail';
}catch(error){report.status='fail';report.error=publicError(error);report.httpCalls=requests.length;}
finally {
  if(handle)await handle.dispose().catch(error=>{report.cleanupError=publicError(error);});
  store?.close();await shutdown.shutdown(0);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  await writeFile(path.resolve('docs/evidence/native-session-probe.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.status!=='pass')process.exitCode=1;
}
