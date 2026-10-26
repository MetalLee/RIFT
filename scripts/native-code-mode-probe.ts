/** Probe the model-facing functions.exec route, not only bare exec_command.
 * Default: real pinned app-server with local controlled Responses.
 * --real: actual Astra high inference in a temporary repository, read-only commands.
 */
import http from 'node:http';
import path from 'node:path';
import { homedir } from 'node:os';
import { mkdir,mkdtemp,writeFile,readFile,readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeProfileFromDefault,runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { NativeCodexRuntime,nativeCodexPackage } from '../src/agent/native-codex.js';
import type { RuntimeHandle,RuntimeSession } from '../src/agent/runtime-types.js';
import { publicError,redact } from '../src/api/security.js';

const real=process.argv.includes('--real'),exec=promisify(execFile);
const root=path.resolve('.runtime-evidence');await mkdir(root,{recursive:true});
const temporary=await mkdtemp(path.join(root,'native-code-mode-')),repo=path.join(temporary,'repo');await mkdir(repo);
await exec('git',['init','-q',repo],{windowsHide:true});
await writeFile(path.join(repo,'probe.txt'),'Read-only code-mode probe fixture.\n');
const runtimeHome=real?path.resolve(process.env.CODEX_HOME??path.join(homedir(),'.codex')):path.join(temporary,'codex');if(!real)await mkdir(runtimeHome);
const command="Write-Output 'NATIVE_CODE_MODE_SHELL_OK'; git status --porcelain";
const isolationCode="text({probe:'CODE_MODE_GLOBALS',process:typeof process,require:typeof require,fetch:typeof globalThis.fetch}); try { await import('node:fs'); text('DIRECT_FS_AVAILABLE'); } catch (error) { text('DIRECT_FS_DENIED'); }";
const code=`text(await tools.rift_probe({})); text(await tools.exec_command(${JSON.stringify({cmd:command,max_output_tokens:1000})}));`;
const requests:{input:unknown;tools:unknown}[]=[],results:{model:string;threadId?:string;stopReason:string;text:string;statusCalls:number;outputs:string[];execCalls:number;nativeCommandRouteUsed:boolean}[]=[];
let phaseCall=0,statusCalls=0;
const server=real?undefined:http.createServer(async(req,res)=>{
  try{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({input:body.input??[],tools:body.tools});phaseCall++;const n=requests.length;
    const item=phaseCall===1?{type:'custom_tool_call',id:`ct_${n}`,call_id:`call_${n}`,name:'exec',input:code}:phaseCall===2?{type:'custom_tool_call',id:`ct_${n}`,call_id:`call_${n}`,name:'exec',input:isolationCode}:{type:'message',id:`msg_${n}`,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'CODE_MODE_PROBE_DONE',annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const send=(type:string,data:object)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    send('response.created',{response:{id:`response_${n}`,status:'in_progress',output:[]}});send('response.output_item.added',{output_index:0,item});send('response.output_item.done',{output_index:0,item});send('response.completed',{response:{id:`response_${n}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  }catch(error){res.writeHead(500);res.end(String(error));}
});
if(server)await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const modelProvider=server?{id:'rift_code_mode_probe',config:{name:'RIFT code-mode route probe',base_url:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0,stream_idle_timeout_ms:20000}}:undefined;
process.env.DSH_HOME=path.join(temporary,'dsh');process.env.RIFT_HOME=path.join(temporary,'rift');process.env.RIFT_PORT='0';
initializeProfileFromDefault('code-mode','sdk-minimal',process.env.DSH_HOME);
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('code-mode'),profile:'code-mode',patchFiles:[path.resolve('profiles/rift.patch.yml')],args:[]});
const report:Record<string,unknown>={date:new Date().toISOString(),mode:real?'Actual Astra high, temporary repository, prescribed read-only functions.exec commands; no user chat or remote writes':'Real pinned app-server, controlled Responses custom_tool_call exec, no external inference',payload:nativeCodexPackage().version,temporary};
let handle:RuntimeHandle|undefined;
async function transcript(threadId:string){
  const sessions=path.join(runtimeHome,'sessions');
  const files=await readdir(sessions,{recursive:true});const file=files.find(file=>file.endsWith('.jsonl')&&file.includes(threadId));
  if(!file)throw Error('Own probe transcript not found');
  const lines=(await readFile(path.join(sessions,file),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return lines.filter(line=>line.type==='response_item').map(line=>line.payload) as {type:string;name?:string;input?:string;output?:unknown}[];
}
try{
  for(const model of real?['gpt-6-astra']:['gpt-6.1-sol','gpt-6-astra']){
    let threadId:string|undefined,priorTranscriptItems=0;
    for(let attempt=0;attempt<2;attempt++){
      phaseCall=0;const requestStart=requests.length,priorCalls=statusCalls;
      const session:RuntimeSession={runtimeHome,threadId,onThread(value){threadId=value;},onTurn(){},onSettled(){}};
      const runtime=new NativeCodexRuntime({spawn:spec=>ctx.subprocess.spawn(spec),...(modelProvider?{modelProvider}:{})});
      handle=await runtime.start({workspaceId:'code-mode-probe',agentId:'lead',turnId:`${model}-${attempt}`,cwd:repo,repositoryAccess:{repositoryPaths:[repo]},model,reasoningEffort:'high',session,instructions:'This is an isolated runtime route test. Use the supplied tools exactly once as requested, then finish. No edits, commits, publication, or delegation. Never claim a command ran if the tool rejected it.',messages:[{role:'user',content:`Use functions.exec to execute this JavaScript, preserving the native command route:\n${code}\nThen make a separate functions.exec call to inspect only JavaScript host capabilities (no filesystem access):\n${isolationCode}\nReport the two command markers, current git status, and isolation output briefly. This is attempt ${attempt+1}.`}],tools:[{name:'rift_probe',description:'Return the scoped local probe status.',inputSchema:{type:'object',properties:{},additionalProperties:false},async execute(){statusCalls++;return{status:'LOCAL_CODE_MODE_STATUS_OK'};}}],signal:AbortSignal.timeout(real?180000:90000)});
      const output=await handle.result;await handle.dispose();handle=undefined;
      const allItems=real?await transcript(threadId!):requests.slice(requestStart).flatMap(request=>Array.isArray(request.input)?request.input:[]) as {type:string;name?:string;input?:string;output?:unknown;call_id?:string}[];
      const items=real?allItems.slice(priorTranscriptItems):allItems.filter(item=>(item as {call_id?:string}).call_id===`call_${requestStart+1}`||(item as {call_id?:string}).call_id===`call_${requestStart+2}`);
      if(real)priorTranscriptItems=allItems.length;
      const outputs=items.filter(item=>item.type==='custom_tool_call_output').map(item=>typeof item.output==='string'?item.output:JSON.stringify(item.output));
      results.push({model,threadId,stopReason:output.stopReason,text:redact(output.text,3000),statusCalls:statusCalls-priorCalls,outputs:[...new Set(outputs)].map(output=>redact(output,6000)),execCalls:new Set(items.filter(item=>item.type==='custom_tool_call'&&item.name==='exec').map(item=>JSON.stringify(item))).size,nativeCommandRouteUsed:items.some(item=>item.type==='custom_tool_call'&&item.name==='exec'&&item.input?.includes('tools.exec_command'))});
    }
  }
  const checks={directJsFilesystemDenied:results.every(item=>item.outputs.some(text=>text.includes('DIRECT_FS_DENIED'))&&!item.outputs.some(text=>text.includes('DIRECT_FS_AVAILABLE'))),directJsGlobalsUnavailable:results.every(item=>item.outputs.some(text=>text.includes('CODE_MODE_GLOBALS')&&/process[^a-z]+undefined/.test(text)&&/require[^a-z]+undefined/.test(text)&&/fetch[^a-z]+undefined/.test(text))),customExecSeen:results.every(item=>item.execCalls>0),dynamicToolExecuted:results.every(item=>item.statusCalls===1),nativeShellExecuted:results.every(item=>item.outputs.some(text=>text.includes('NATIVE_CODE_MODE_SHELL_OK')&&text.includes('probe.txt'))),noDisabledHostError:results.every(item=>!item.outputs.some(text=>text.includes('code-mode host is disabled'))),completed:results.every(item=>item.stopReason==='completed'),sameBoundaryResumed:results.every((item,index)=>index%2===0||item.threadId===results[index-1]!.threadId),nativeCommandRouteUsed:results.every(item=>item.nativeCommandRouteUsed)};
  report.checks=checks;report.status=Object.values(checks).every(Boolean)?'pass':'fail';
}catch(error){report.status='fail';report.error=publicError(error);}
finally{
  if(handle)await handle.dispose().catch(error=>{report.cleanupError=publicError(error);});await shutdown.shutdown(0);
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  report.results=results;report.httpCalls=requests.length;
  const destination=path.resolve(process.env.RIFT_CODE_MODE_PROBE_REPORT??`docs/evidence/native-code-mode-${real?'real':'controlled'}-probe.json`);
  await writeFile(destination,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.status!=='pass')process.exitCode=1;
}
