/** Live smoke test: writable Host shell despite native read-only labels, and internal HTTPS egress. */
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {initializeProfileFromDefault,runProfile} from '@deepseek-ai/dsh/profile-boot';
import {loadLayeredEnv} from '@deepseek-ai/dsh-app-boot';
import {NativeCodexRuntime} from '../src/agent/native-codex.js';
import type {RuntimeHandle} from '../src/agent/runtime-types.js';

const home=await realpath(await mkdtemp(path.join(tmpdir(),'rift-host-capabilities-')));
const workspace=path.join(home,'workspace');await mkdir(workspace);
const previousHome=process.env.DSH_HOME;process.env.DSH_HOME=path.join(home,'dsh');
initializeProfileFromDefault('capabilities','sdk-minimal',process.env.DSH_HOME);
const patch=path.join(home,'headless.yml');await writeFile(patch,'- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n');
const boot=await runProfile({environment:loadLayeredEnv('capabilities'),profile:'capabilities',patchFiles:[patch],args:[]});
let handle:RuntimeHandle|undefined;
try {
 const runtime=new NativeCodexRuntime({spawn:spec=>boot.ctx.subprocess.spawn(spec)});
 handle=await runtime.start({workspaceId:'probe',agentId:'lead',turnId:'host-capabilities-probe',cwd:workspace,model:'gpt-6-astra',reasoningEffort:'medium',
  repositoryAccess:{repositoryPaths:[],workspaceDirectory:workspace,shellHome:path.join(home,'shell-home')},
  instructions:'This is a bounded capability validation. Do not delegate or install software. Complete the user request using the available tools, then return a short factual summary. Never claim unavailable capabilities without a tool receipt.',
  messages:[{role:'user',content:'在当前工作区创建 permission-probe.txt，内容为 HOST_WRITE_OK。然后使用 curl 访问 https://skills.deepwisdomai.com/my-skills，把页面保存为 skill-page.html，并报告 HTTP 状态。不要修改其他文件或安装技能。'}],tools:[],signal:AbortSignal.timeout(180000),
  onEvent:event=>{if(event.type==='tool.started')console.log('tool:',event.toolName);},
 });
 const result=await handle.result;
 assert.equal((await readFile(path.join(workspace,'permission-probe.txt'),'utf8')).trim(),'HOST_WRITE_OK');
 const page=await readFile(path.join(workspace,'skill-page.html'),'utf8');assert(page.includes('<html')||page.includes('<!DOCTYPE'));
 console.log(JSON.stringify({passed:true,model:'gpt-6-astra',writeVerified:true,internalHttpsBytes:Buffer.byteLength(page),summary:result.text}));
} finally {
 await handle?.dispose();await boot.shutdown.shutdown(0);
 if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;
 await rm(home,{recursive:true,force:true});
}
