import type { Context } from '@deepseek-ai/cordis';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RiftError, invariant } from '../contracts/index.js';
import { redact } from '../api/security.js';
import { nativeCodexPackage, nativeRepositoryRoots } from './native-codex.js';
import type { RuntimeTool, RuntimeTurnInput } from './runtime-types.js';

const commandSchema=z.object({cmd:z.string().min(1).max(32000),cwd:z.string().min(1).optional(),timeoutMs:z.number().int().min(100).max(300000).default(120000)}).strict();
const canonical=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);

/** DSH uses the pinned native OS sandbox for its ordinary shell tool. This is
 * not a command-name filter: git, gh and project commands retain their usual
 * semantics, while writes are bounded by the Host's repository capabilities. */
export async function createRepositoryShell(subprocess:Context['subprocess'],input:Pick<RuntimeTurnInput,'cwd'|'repositoryAccess'|'signal'>):Promise<{tool:RuntimeTool;dispose():Promise<void>}> {
  invariant(input.repositoryAccess?.repositoryPaths.length,'REPOSITORY_REQUIRED','Repository execution requires Host-associated repositories.');
  const paths=[...input.repositoryAccess.repositoryPaths];
  const roots=await nativeRepositoryRoots(input.cwd,paths,input.signal);
  const rootKeys=roots.map(canonical).sort();
  let shell:string;
  try{shell=await subprocess.resolveExecutable(process.platform==='win32'?'pwsh':'bash',undefined,input.signal);}
  catch(error){if(process.platform!=='win32')throw error;shell=await subprocess.resolveExecutable(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),undefined,input.signal);}
  const packageArgs=nativeCodexPackage().argv.slice(0,-2);
  // CLI sandbox profiles deliberately do not inherit the legacy app-server
  // writable_roots settings. Supply one complete named permission profile.
  const filesystem=[[':root','read'],...roots.map(root=>[root,'write'])].map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
  const permissions=`{rift_repositories={filesystem={${filesystem}},network={enabled=true}}}`;
  const config={approval_policy:'never','features.network_proxy':false,...process.platform==='win32'?{'windows.sandbox':'unelevated'}:{}};
  const overrides=['-c',`permissions=${permissions}`,...Object.entries(config).flatMap(([key,value])=>['-c',`${key}=${JSON.stringify(value)}`])];
  const stop=new AbortController();
  const active=new Set<SubprocessHandle>();
  const pending=new Set<Promise<unknown>>();
  let closed=false;
  const env:NodeJS.ProcessEnv={GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GH_PROMPT_DISABLED:'1'};
  for(const key of Object.keys(process.env))if(key.toUpperCase().startsWith('CODEX_')&&key.toUpperCase()!=='CODEX_HOME')env[key]=undefined;
  const cleanup=async(child:SubprocessHandle)=>{
    child.terminate();
    if(!await child.waitForExit(AbortSignal.timeout(10000)))throw new RiftError('CLEANUP_UNKNOWN','Repository command descendants have not confirmed exit.');
    await child.done.catch(()=>{});active.delete(child);
  };
  const tool:RuntimeTool={name:'exec_command',description:'Run a shell command in the Host-associated workspace repositories. Supports normal git commits and gh PR commands. Remote writes require the user’s request. No background services or detached commands; all descendants must finish before returning. Other filesystem locations remain outside the write boundary.',inputSchema:{type:'object',properties:{cmd:{type:'string'},cwd:{type:'string',description:'Optional existing directory inside the granted repository roots.'},timeoutMs:{type:'integer',minimum:100,maximum:300000}},required:['cmd'],additionalProperties:false},
    execute(args,signal){
      const operation=(async()=>{
        invariant(!closed,'TURN_STOPPED','Repository execution is closed.');
        const parsed=commandSchema.parse(args),combined=AbortSignal.any([input.signal,signal,stop.signal,AbortSignal.timeout(parsed.timeoutMs)]);combined.throwIfAborted();
        const current=await nativeRepositoryRoots(input.cwd,paths,combined);
        invariant(JSON.stringify(current.map(canonical).sort())===JSON.stringify(rootKeys),'REPOSITORY_IDENTITY_CHANGED','Repository identity changed during this execution.');
        const cwd=await realpath(parsed.cwd?path.resolve(input.cwd,parsed.cwd):input.cwd),key=canonical(cwd);
        invariant(rootKeys.some(root=>key===root||key.startsWith(root+path.sep)),'REPOSITORY_SCOPE','Command cwd is outside the granted repositories.');
        combined.throwIfAborted();
        const command=process.platform==='win32'?[shell,'-NoLogo','-NoProfile','-NonInteractive','-Command',parsed.cmd]:[shell,'--noprofile','--norc','-c',parsed.cmd];
        const child=subprocess.spawn({argv:[...packageArgs,'sandbox','-P','rift_repositories',...overrides,'-C',cwd,'--',...command],cwd,env,signal:combined,graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:131072},stderr:{maxBytes:131072}}});active.add(child);
        try{
          const outcome=await child.done;
          await cleanup(child);combined.throwIfAborted();
          const stdout=child.collected.stdout?.readFrom(0),stderr=child.collected.stderr?.readFrom(0);
          return{exitCode:outcome.exitCode,stdout:redact(stdout?.text??'',131072),stderr:redact(stderr?.text??'',131072),truncated:Boolean(stdout?.lossy||stderr?.lossy)};
        }finally{if(active.has(child))await cleanup(child);}
      })();
      pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation;
    }};
  return{tool,dispose:async()=>{closed=true;stop.abort();await Promise.allSettled([...pending]);await Promise.all([...active].map(cleanup));}};
}
