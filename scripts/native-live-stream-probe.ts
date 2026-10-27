import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { NativeCodexRuntime } from '../src/agent/native-codex.js';
import type { RuntimeEvent, RuntimeHandle } from '../src/agent/runtime-types.js';
import { publicError } from '../src/api/security.js';

const home=await mkdtemp(path.join(tmpdir(),'rift-native-stream-probe-'));
const previousHome=process.env.DSH_HOME;
process.env.DSH_HOME=path.join(home,'dsh');
initializeProfileFromDefault('native-stream','sdk-minimal',process.env.DSH_HOME);
const patch=path.join(home,'headless.patch.yml');await writeFile(patch,'- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n');
const boot=await runProfile({environment:loadLayeredEnv('native-stream'),profile:'native-stream',patchFiles:[patch],args:[]});
const native=new NativeCodexRuntime({spawn:spec=>boot.ctx.subprocess.spawn(spec)});
const report:{at:string;mode:string;model:string;runs:Record<string,unknown>[];passed?:boolean}={at:new Date().toISOString(),mode:'live authenticated model; actual native app-server, scoped tool and runtime events',model:'gpt-6.1-sol',runs:[]};
try {
  for(const language of ['zh','en']){
    let handle:RuntimeHandle|undefined;const events:{event:RuntimeEvent;ms:number}[]=[];const started=performance.now();
    try {
      handle=await native.start({workspaceId:'probe',agentId:'lead',turnId:`native-stream-${language}`,cwd:home,model:report.model,reasoningEffort:'low',
        instructions:'This is a bounded streaming validation. Before calling the tool, send one concise progress message in the requested language. Call rift_probe exactly once, then give only the requested final response. Do not inspect files or use other tools.',
        messages:[{role:'user',content:language==='zh'?'请先用一句中文说明即将检查流式连接，然后调用 rift_probe，最后只回复“中文验证完成”。':'First give one short English progress update about checking the stream, call rift_probe, then reply only "English validation complete".'}],
        tools:[{name:'rift_probe',description:'Verify the scoped stream tool',inputSchema:{type:'object',properties:{},additionalProperties:false},async execute(){return{verified:true};}}],
        signal:AbortSignal.timeout(90000),onEvent:event=>events.push({event,ms:Number((performance.now()-started).toFixed(2))})});
      const result=await handle.result;
      const toolStart=events.find(value=>value.event.type==='tool.started');
      const commentary=events.find(value=>value.event.type==='message.completed'&&value.event.kind==='commentary');
      const firstText=events.find(value=>value.event.type==='message.delta');
      const passed=result.stopReason==='completed'&&!!toolStart&&!!commentary&&!!firstText&&firstText.ms<toolStart.ms&&events.some(value=>value.event.type==='tool.completed');
      report.runs.push({language,passed,stopReason:result.stopReason,firstTextMs:firstText?.ms,commentaryCompletedMs:commentary?.ms,toolStartedMs:toolStart?.ms,totalMs:Number((performance.now()-started).toFixed(2)),eventTypes:events.map(value=>value.event.type),finalText:result.finalText??result.text});
      console.log(JSON.stringify({language,passed,events:events.length}));
    } catch(error) { report.runs.push({language,passed:false,error:publicError(error)});console.log(JSON.stringify({language,error:publicError(error)})); }
    finally { await handle?.dispose(); }
  }
  report.passed=report.runs.every(run=>run.passed===true);
  await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/native-live-stream.json',JSON.stringify(report,null,2)+'\n');
  if(!report.passed)process.exitCode=1;
} finally {
  await boot.shutdown.shutdown(0);
  if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;
  await rm(home,{recursive:true,force:true});
}
