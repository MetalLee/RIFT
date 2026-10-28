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
const report:{at:string;mode:string;model:string;runs:Record<string,unknown>[];passed?:boolean}={at:new Date().toISOString(),mode:'live authenticated model; actual native app-server, scoped tool and runtime events',model:process.env.RIFT_PROBE_MODEL??'gpt-6-astra',runs:[]};
try {
  for(const language of ['zh','en']){
    let handle:RuntimeHandle|undefined;const events:{event:RuntimeEvent;ms:number}[]=[];const started=performance.now();
    try {
      handle=await native.start({workspaceId:'probe',agentId:'lead',turnId:`native-stream-${language}`,cwd:home,model:report.model,reasoningEffort:'medium',
        instructions:'Solve the user problem in the requested language. Use rift_probe to verify the available hours. Give a concise answer with the schedule. Do not inspect files or use other tools. Do not add an opening plan or narrate tool calls.',
        messages:[{role:'user',content:language==='zh'?'安排五项任务：A耗时2小时，B耗时3小时，C耗时1小时且依赖A，D耗时2小时且依赖B和C，E耗时1小时且依赖D。只有一名员工，9点上班，12至13点午休，18点下班。任务不能拆分，调用rift_probe核对后给出最早完成时间及安排。':'Schedule five tasks: A takes 2 hours, B takes 3, C takes 1 and depends on A, D takes 2 and depends on B and C, E takes 1 and depends on D. One worker works 9am to 6pm, with lunch noon to 1pm. Tasks cannot be split. Check hours with rift_probe and give the earliest completion time and schedule.'}],
        tools:[{name:'rift_probe',description:'Verify the scoped stream tool',inputSchema:{type:'object',properties:{},additionalProperties:false},async execute(){return{hours:'09:00-12:00,13:00-18:00 each day',workers:1};}}],
        signal:AbortSignal.timeout(90000),onEvent:event=>events.push({event,ms:Number((performance.now()-started).toFixed(2))})});
      const result=await handle.result;
      const toolStart=events.find(value=>value.event.type==='tool.started');
      const reasoning=events.find(value=>value.event.type==='message.started'&&value.event.kind==='reasoning_summary');
      const firstText=events.find(value=>value.event.type==='message.delta');
      const passed=result.stopReason==='completed'&&!!toolStart&&!!reasoning&&!!firstText&&events.some(value=>value.event.type==='message.delta'&&value.event.messageId.startsWith('summary:'))&&events.some(value=>value.event.type==='tool.completed');
      report.runs.push({language,passed,stopReason:result.stopReason,firstTextMs:firstText?.ms,reasoningStartedMs:reasoning?.ms,toolStartedMs:toolStart?.ms,totalMs:Number((performance.now()-started).toFixed(2)),eventTypes:events.map(value=>value.event.type),finalText:result.finalText??result.text});
      console.log(JSON.stringify({language,passed,events:events.length}));
    } catch(error) { report.runs.push({language,passed:false,error:publicError(error)});console.log(JSON.stringify({language,error:publicError(error)})); }
    finally { await handle?.dispose(); }
  }
  report.passed=report.runs.every(run=>run.passed===true);
  await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/native-reasoning-stream.json',JSON.stringify(report,null,2)+'\n');
  if(!report.passed)process.exitCode=1;
} finally {
  await boot.shutdown.shutdown(0);
  if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;
  await rm(home,{recursive:true,force:true});
}
