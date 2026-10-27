/** Independent real-binary negative probe for the model-facing exec wrapper. */
import http from 'node:http';
import path from 'node:path';
import { mkdir,mkdtemp,writeFile,access } from 'node:fs/promises';
import { initializeProfileFromDefault,runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { NativeCodexRuntime,nativeCodexPackage } from '../src/agent/native-codex.js';
import type { RuntimeHandle } from '../src/agent/runtime-types.js';
import { publicError } from '../src/api/security.js';

await mkdir('.runtime-evidence',{recursive:true});const temporary=await mkdtemp(path.resolve('.runtime-evidence/readonly-wrapper-review-')),repo=path.join(temporary,'repo'),runtimeHome=path.join(temporary,'codex');
await mkdir(repo);await mkdir(runtimeHome);await writeFile(path.join(repo,'baseline.txt'),'FORMAL_READ_STILL_AVAILABLE');
let phase:'review'|'analysis'='review',step=0,port=0,dynamicCalls=0,networkCalls=0;
const requests:{phase:string;input:any[]}[]=[],results:Record<string,unknown>[]=[],checks:Record<string,boolean>={};
const server=http.createServer(async(req,res)=>{
  if(req.url==='/forbidden'){networkCalls++;res.end('side effect endpoint reached');return;}
  try{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push({phase,input:body.input??[]});step++;const n=requests.length;
    const marker=path.join(repo,`${phase}-forbidden.txt`),command=`Set-Content -LiteralPath '${marker.replaceAll("'","''")}' -Value forbidden; Invoke-WebRequest -Uri 'http://127.0.0.1:${port}/forbidden' -UseBasicParsing -TimeoutSec 2`;
    const code=step===1?`text(await tools.rift_probe({})); text(await tools.exec_command(${JSON.stringify({cmd:command,max_output_tokens:1000})}));`:`try { (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)},'forbidden'); } catch {} if(typeof fetch==='function') await fetch('http://127.0.0.1:${port}/forbidden'); text('WRAPPER_JS_EXECUTED');`;
    const item=step<=2?{type:'custom_tool_call',id:`ct_${n}`,call_id:`call_${n}`,name:'exec',input:code}:step===3?{type:'function_call',id:`fc_${n}`,call_id:`call_${n}`,name:'rift_read_file',arguments:JSON.stringify({path:'baseline.txt'})}:{type:'message',id:`msg_${n}`,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'FORMAL_WRAPPER_PROBE_COMPLETE',annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream'});const send=(type:string,data:object)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    send('response.created',{response:{id:`response_${n}`,status:'in_progress',output:[]}});send('response.output_item.added',{output_index:0,item});send('response.output_item.done',{output_index:0,item});send('response.completed',{response:{id:`response_${n}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));port=(server.address() as import('node:net').AddressInfo).port;
process.env.DSH_HOME=path.join(temporary,'dsh');process.env.RIFT_HOME=path.join(temporary,'rift');process.env.RIFT_PORT='0';initializeProfileFromDefault('readonly-wrapper-review','sdk-minimal',process.env.DSH_HOME);
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('readonly-wrapper-review'),profile:'readonly-wrapper-review',patchFiles:[path.resolve('profiles/rift.patch.yml')],args:[]});
const modelProvider={id:'formal_wrapper_review',config:{name:'Independent formal wrapper review',base_url:`http://127.0.0.1:${port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0,stream_idle_timeout_ms:20000}};
const report:Record<string,unknown>={date:new Date().toISOString(),mode:'Real pinned app-server, controlled custom_tool_call exec against formal review/analysis; no external inference or remote writes',payload:nativeCodexPackage().version,temporary};let handle:RuntimeHandle|undefined;
const exists=async(file:string)=>{try{await access(file);return true;}catch{return false;}};
try{
  for(const mode of ['review','analysis'] as const){
    phase=mode;step=0;const priorDynamic=dynamicCalls,priorNetwork=networkCalls;
    const runtime=new NativeCodexRuntime({mode,spawn:spec=>ctx.subprocess.spawn(spec),modelProvider});
    handle=await runtime.start({workspaceId:'independent-formal',agentId:'formal',turnId:mode,cwd:repo,repositoryAccess:{repositoryPaths:[repo]},model:'gpt-6-astra',instructions:'Formal read-only inspection. Use only scoped Host tools.',messages:[{role:'user',content:'Verify the provided read-only fixture.'}],session:{runtimeHome,onThread(){},onTurn(){},onSettled(){}},tools:[{name:'rift_probe',description:'Count forbidden wrapped calls.',inputSchema:{type:'object',properties:{}},async execute(){dynamicCalls++;return{unexpected:true};}}],signal:AbortSignal.timeout(60000)});
    const result=await handle.result;await handle.dispose();handle=undefined;
    const outputs=[...new Set(requests.filter(item=>item.phase===mode).flatMap(item=>item.input).filter(item=>item.type==='custom_tool_call_output'||item.type==='function_call_output').map(item=>typeof item.output==='string'?item.output:JSON.stringify(item.output)))];
    const customOutputs=new Map(requests.filter(item=>item.phase===mode).flatMap(item=>item.input).filter(item=>item.type==='custom_tool_call_output').map(item=>[item.call_id,typeof item.output==='string'?item.output:JSON.stringify(item.output)]));
    const text=outputs.join('\n');checks[`${mode}WrapperRejected`]=customOutputs.size===2&&[...customOutputs.values()].every(output=>/unsupported custom tool call: exec|code-mode host is disabled/.test(output))&&!text.includes('WRAPPER_JS_EXECUTED');checks[`${mode}NoToolOrNetworkExecution`]=dynamicCalls===priorDynamic&&networkCalls===priorNetwork;checks[`${mode}NoFileSideEffect`]=!await exists(path.join(repo,`${mode}-forbidden.txt`));checks[`${mode}LegitimateReadWorks`]=text.includes('FORMAL_READ_STILL_AVAILABLE')&&result.stopReason==='completed';
    results.push({mode,stopReason:result.stopReason,dynamicCalls:dynamicCalls-priorDynamic,networkCalls:networkCalls-priorNetwork,outputs});
  }
  report.status=Object.values(checks).every(Boolean)?'pass':'fail';
}catch(error){report.status='fail';report.error=publicError(error);}
finally{await handle?.dispose();await shutdown.shutdown(0);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));report.checks=checks;report.results=results;report.httpCalls=requests.length;await writeFile('docs/evidence/native-code-mode-readonly-independent-probe.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.status!=='pass')process.exitCode=1;}
