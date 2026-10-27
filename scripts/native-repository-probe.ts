/** Real pinned app-server and sandbox with a local Responses endpoint; no external inference. */
import http from 'node:http';
import path from 'node:path';
import { mkdir,mkdtemp,writeFile,access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { initializeProfileFromDefault,runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-subprocess';
import { NativeCodexRuntime,nativeCodexPackage,nativeRepositoryRoots } from '../src/agent/native-codex.js';
import type { RuntimeHandle,RuntimeSession } from '../src/agent/runtime-types.js';
import { publicError } from '../src/api/security.js';

const exec=promisify(execFile),root=path.resolve('.runtime-evidence');await mkdir(root,{recursive:true});
const model=process.argv[2]??'gpt-6-astra';
if(!['gpt-6-astra','gpt-6.1-sol'].includes(model))throw new Error('Unsupported probe model.');
const temporary=await mkdtemp(path.join(root,'native-repository-')),repo=path.join(temporary,'first'),second=path.join(temporary,'second'),worktree=path.join(temporary,'linked'),outside=path.join(temporary,'outside.txt'),runtimeHome=path.join(temporary,'codex');await mkdir(runtimeHome);
const git=async(cwd:string,args:string[])=>{const result=await exec('git',['-C',cwd,...args],{windowsHide:true});return result.stdout.trim();};
for(const cwd of [repo,second]){await mkdir(cwd);await git(cwd,['init','-q','-b','main']);await git(cwd,['config','user.name','RIFT probe']);await git(cwd,['config','user.email','rift-probe@example.invalid']);await writeFile(path.join(cwd,'base.txt'),'base\n');await git(cwd,['add','.']);await git(cwd,['commit','-qm','base']);}
await git(repo,['worktree','add','-q','-b','probe-worktree',worktree]);
const before=await git(worktree,['rev-parse','HEAD']),secondBefore=await git(second,['rev-parse','HEAD']);
const requests:{input:string;tools:unknown;phase:string}[]=[];let networkRequests=0,phase='develop',phaseCall=0,port=0;const networkByPhase:Record<string,number>={};
const codeModeCalls:string[]=[];
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
const require=createRequire(import.meta.url);
const viteRequire=createRequire(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json'));
const subprocessProbe=`require(${JSON.stringify(viteRequire.resolve('esbuild'))}).transformSync('let answer = 42'); const cp=require('node:child_process'); cp.execFileSync(process.execPath,['-e','process.stdout.write("CHILD_OK")']); if(process.platform==='win32')cp.execSync('net use'); console.log('SUBPROCESS_PROBE_OK');`;
const commands=()=>phase==='develop'?[
  `& ${quote(process.execPath)} -e ${quote(subprocessProbe)}`,
  `if ($LASTEXITCODE -ne 0) { throw 'Node/esbuild/Windows child process probe failed' }`,
  `Set-Content -LiteralPath ${quote(path.join(worktree,'native.txt'))} -Value 'native worktree commit' -NoNewline -ErrorAction Stop`,
  `git -C ${quote(worktree)} add native.txt`,
  `if ($LASTEXITCODE -ne 0) { throw 'git add failed' }`,
  `git -C ${quote(worktree)} commit -m 'native worktree commit'`,
  `if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }`,
  `Set-Content -LiteralPath ${quote(path.join(second,'native.txt'))} -Value 'second associated repository' -NoNewline -ErrorAction Stop`,
  `git -C ${quote(second)} add native.txt`,
  `git -C ${quote(second)} commit -m 'second repository commit'`,
  `if ($LASTEXITCODE -ne 0) { throw 'second commit failed' }`,
  `try { Set-Content -LiteralPath ${quote(outside)} -Value 'out of scope' -ErrorAction Stop; 'OUTSIDE_ALLOWED' } catch { 'OUTSIDE_DENIED' }`,
  `(Invoke-WebRequest -Uri 'http://127.0.0.1:${port}/network' -UseBasicParsing).Content`,
  `'REPOSITORY_COMMIT_OK'`,
].join('\n'):phase==='resume'?[
  `Set-Content -LiteralPath ${quote(path.join(worktree,'developer.txt'))} -Value 'resumed developer commit' -NoNewline -ErrorAction Stop`,
  `git -C ${quote(worktree)} add developer.txt`,
  `git -C ${quote(worktree)} commit -m 'resumed developer commit'`,
  `if ($LASTEXITCODE -ne 0) { throw 'resumed developer commit failed' }`,
  `'DEVELOPER_COMMIT_OK'`,
].join('\n'):[
  `try { Set-Content -LiteralPath ${quote(path.join(worktree,`${phase}-forbidden.txt`))} -Value 'probe' -ErrorAction Stop; '${phase.toUpperCase()}_WRITE_ALLOWED' } catch { '${phase.toUpperCase()}_WRITE_DENIED' }`,
  `try { Invoke-WebRequest -Uri 'http://127.0.0.1:${port}/network' -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop | Out-Null; '${phase.toUpperCase()}_NETWORK_ALLOWED' } catch { '${phase.toUpperCase()}_NETWORK_DENIED' }`,
  `try { Invoke-WebRequest -Uri 'https://github.com' -Method Head -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop | Out-Null; '${phase.toUpperCase()}_REMOTE_NETWORK_ALLOWED' } catch { '${phase.toUpperCase()}_REMOTE_NETWORK_DENIED' }`,
].join('\n');
const server=http.createServer(async(req,res)=>{
  if(req.url==='/network'){networkRequests++;networkByPhase[phase]=(networkByPhase[phase]??0)+1;res.end('NETWORK_OK');return;}
  try{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push({input:JSON.stringify(body.input??[]),tools:body.tools,phase});phaseCall++;
    const n=requests.length,formal=phase==='review'||phase==='analysis';
    const nativeCall=phaseCall===1?{name:'exec_command',args:{cmd:commands(),shell:'powershell',login:false,yield_time_ms:10000,max_output_tokens:3000}}:formal&&phaseCall===2?{name:'rift_read_file',args:{path:'native.txt'}}:formal&&phaseCall===3?{name:'rift_list_files',args:{path:'.'}}:formal&&phaseCall===4?{name:'rift_read_file',args:{path:'../outside.txt'}}:undefined;
    const item=nativeCall?formal?{type:'function_call',id:`fc_${n}`,call_id:`call_${n}`,name:nativeCall.name,arguments:JSON.stringify(nativeCall.args)}:{type:'custom_tool_call',id:`fc_${n}`,call_id:`call_${n}`,name:'exec',namespace:'functions',input:`text(await tools.rift_probe({})); const result = await tools.exec_command(${JSON.stringify(nativeCall.args)}); text(result); if (result.exit_code !== 0) throw new Error("Repository command failed"); text("CODE_MODE_SHELL_OK");`}:{type:'message',id:`msg_${n}`,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:`PROBE_${phase}_DONE`,annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});const send=(type:string,value:object)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
    send('response.created',{response:{id:`response_${n}`,status:'in_progress',output:[]}});send('response.output_item.added',{output_index:0,item});send('response.output_item.done',{output_index:0,item});send('response.completed',{response:{id:`response_${n}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as import('node:net').AddressInfo).port;
process.env.DSH_HOME=path.join(temporary,'dsh');process.env.RIFT_HOME=path.join(temporary,'rift');process.env.RIFT_PORT='0';initializeProfileFromDefault('native-repository','sdk-minimal',process.env.DSH_HOME);
const report:Record<string,unknown>={date:new Date().toISOString(),payload:nativeCodexPackage().version,model,mode:'Real pinned app-server; local controlled Responses; full-access developer start/resume, child processes and Git commits; restricted formal review/analysis; no external inference or remote writes',temporary};
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('native-repository'),profile:'native-repository',patchFiles:[path.resolve('profiles/rift.patch.yml')],args:[]});
const modelProvider={id:'rift_repository_probe',config:{name:'RIFT repository probe',base_url:`http://127.0.0.1:${port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0,stream_idle_timeout_ms:20000}};
let handle:RuntimeHandle|undefined,threadId:string|undefined;const threads:string[]=[],spawnArguments:string[][]=[];
try{
  const roots=await nativeRepositoryRoots(worktree,[repo,second],new AbortController().signal);report.writableRoots=roots;
  const session=():RuntimeSession=>({threadId,runtimeHome,onThread(value){threadId=value;},onTurn(){},onSettled(){}});
  for(const mode of ['discussion','develop','review','analysis'] as const){
    phase=mode==='discussion'?'develop':mode;phaseCall=0;
    // First call proves the workspace Lead discussion has native repository tools.
    // Resumed develop call exercises the exact current roots again without writes.
    if(mode==='develop')phase='resume';else threadId=undefined;
    const runtime=new NativeCodexRuntime({mode,spawn:spec=>{spawnArguments.push([...spec.argv]);return ctx.subprocess.spawn(spec);},modelProvider});
    handle=await runtime.start({workspaceId:'probe',agentId:'lead',turnId:mode,cwd:worktree,repositoryAccess:{repositoryPaths:[repo,second]},model,instructions:'Execute the requested local test command. Do not delegate.',session:session(),messages:[{role:'user',content:'Run the supplied probe command once then finish.'}],tools:[{name:'rift_probe',description:'Confirm the scoped Host tool gateway.',inputSchema:{type:'object',properties:{},additionalProperties:false},async execute(){codeModeCalls.push(phase);return{marker:'CODE_MODE_HOST_TOOL_OK'};}}],signal:AbortSignal.timeout(90000)});
    await handle.result;await handle.dispose();handle=undefined;threads.push(threadId!);
  }
  const exists=async(file:string)=>{try{await access(file);return true;}catch{return false;}};
  const after=await git(worktree,['rev-parse','HEAD']),secondAfter=await git(second,['rev-parse','HEAD']);
  const toolOutputs=[...new Set(requests.flatMap(request=>{try{return JSON.parse(request.input).filter((item:{type:string})=>['function_call_output','custom_tool_call_output'].includes(item.type)).map((item:{output:unknown})=>typeof item.output==='string'?item.output:JSON.stringify(item.output));}catch{return[];}}))] as string[];
  const checks={worktreeCommit:after!==before&&(await git(worktree,['show','HEAD:native.txt']))==='native worktree commit',secondRepositoryCommit:secondAfter!==secondBefore&&(await git(second,['show','HEAD:native.txt']))==='second associated repository',resumedDeveloperCommit:(await git(worktree,['show','HEAD:developer.txt']))==='resumed developer commit'&&toolOutputs.some(x=>x.includes('DEVELOPER_COMMIT_OK')),sameThread:threads[0]===threads[1],reviewAndAnalysisIndependent:threads[2]!==threads[0]&&threads[3]!==threads[0],fullAccessOutsideWrite:await exists(outside)&&toolOutputs.some(x=>x.includes('OUTSIDE_ALLOWED')),reviewReadOnly:!await exists(path.join(worktree,'review-forbidden.txt')),analysisReadOnly:!await exists(path.join(worktree,'analysis-forbidden.txt')),networkAllowed:networkRequests>0,nativeToolExecuted:toolOutputs.some(x=>x.includes('REPOSITORY_COMMIT_OK')&&x.includes('CODE_MODE_SHELL_OK')),fullAccessStartAndResume:spawnArguments.slice(0,2).every(args=>args.includes('sandbox_mode="danger-full-access"')),formalModesRemainRestricted:spawnArguments.slice(2).every(args=>!args.some(arg=>arg.includes('danger-full-access'))),childProcesses:toolOutputs.some(output=>output.includes('SUBPROCESS_PROBE_OK'))};
  const formalResults=Object.fromEntries(['review','analysis'].map(mode=>[mode,requests.filter(r=>r.phase===mode).flatMap(r=>JSON.parse(r.input).filter((item:{type:string})=>item.type==='function_call_output').map((item:{output:unknown})=>typeof item.output==='string'?item.output:JSON.stringify(item.output))).join('\n')])) as Record<string,string>;
  const networkChecks={reviewNetworkDenied:!networkByPhase.review,analysisNetworkDenied:!networkByPhase.analysis,formalNativeShellRejected:['review','analysis'].every(mode=>/unknown|unsupported|unrecognized|not found|not available|not supported/i.test(formalResults[mode]!)),formalReadSucceeded:['review','analysis'].every(mode=>formalResults[mode]!.includes('native worktree commit')),formalListSucceeded:['review','analysis'].every(mode=>formalResults[mode]!.includes('entries')),formalOutsideReadDenied:['review','analysis'].every(mode=>formalResults[mode]!.includes('UNAUTHORIZED'))};
  const codeModeChecks={codeModeHostStartAndResume:JSON.stringify(codeModeCalls)===JSON.stringify(['develop','resume']),noDisabledHostError:!toolOutputs.some(output=>output.includes('code-mode host is disabled'))};
  report.checks={...checks,...networkChecks,...codeModeChecks};report.commits={before,after,secondBefore,secondAfter};report.networkRequests=networkRequests;report.networkByPhase=networkByPhase;report.httpCalls=requests.length;report.status=Object.values({...checks,...networkChecks,...codeModeChecks}).every(Boolean)?'pass':'fail';
  report.threads=threads;report.toolOutputs=toolOutputs;report.spawnArguments=spawnArguments;
  report.formalToolResults=formalResults;
}catch(error){report.status='fail';report.error=publicError(error);report.httpCalls=requests.length;report.toolContexts=requests.map(x=>x.input.slice(-5000));}
finally{
  if(handle)await handle.dispose().catch(error=>{report.cleanupError=publicError(error);});await shutdown.shutdown(0);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  await writeFile(path.resolve('docs/evidence/native-full-access-probe.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.status!=='pass')process.exitCode=1;
}
