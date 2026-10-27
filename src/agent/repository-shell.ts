import { sandboxCommand } from './filesystem-sandbox.js';
import type { Context } from '@deepseek-ai/cordis';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RiftError, invariant } from '../contracts/index.js';
import { redact } from '../api/security.js';
import { nativeRepositoryRoots } from './native-codex.js';
import type { RuntimeTool, RuntimeTurnInput } from './runtime-types.js';

const commandSchema=z.object({cmd:z.string().min(1).max(32000),cwd:z.string().min(1).optional(),timeoutMs:z.number().int().min(100).max(2147483647).default(120000)}).strict();
const canonical=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);

/** DSH uses the pinned native OS sandbox for its ordinary shell tool. This is
 * not a command-name filter: git, gh and project commands retain their usual
 * semantics, while writes are bounded by the Host's repository capabilities. */
export async function createRepositoryShell(subprocess:Context['subprocess'],input:Pick<RuntimeTurnInput,'cwd'|'repositoryAccess'|'signal'>):Promise<{tool:RuntimeTool;dispose():Promise<void>}> {
  invariant(input.repositoryAccess&&(input.repositoryAccess.repositoryPaths.length||input.repositoryAccess.workspaceDirectory),'REPOSITORY_REQUIRED','Repository execution requires Host-associated repositories.');
  const paths=[...input.repositoryAccess.repositoryPaths];
  const roots=await nativeRepositoryRoots(input.cwd,paths,input.signal,input.repositoryAccess?.workspaceDirectory);
  const rootKeys=roots.map(canonical).sort();
  const stop=new AbortController();
  const active=new Set<SubprocessHandle>();
  const pending=new Set<Promise<unknown>>();
  let closed=false;
  const env:NodeJS.ProcessEnv=Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined]));
  const cleanup=async(child:SubprocessHandle)=>{
    child.terminate();
    if(!await child.waitForExit(AbortSignal.timeout(10000)))throw new RiftError('CLEANUP_UNKNOWN','Repository command descendants have not confirmed exit.');
    await child.done.catch(()=>{});active.delete(child);
  };
  const tool:RuntimeTool={name:'exec_command',description:'Run a shell command in the Host-associated workspace repositories. Supports npm/npx/pnpm installs, public HTTP(S) Git downloads, local commits and project commands. Public HTTP(S) uses the configured proxy; global packages and caches persist in a private workspace HOME. No background services or detached commands; all descendants must finish before returning. Other workspaces, Host credentials and management networking remain inaccessible.',inputSchema:{type:'object',properties:{cmd:{type:'string'},cwd:{type:'string',description:'Optional existing directory inside the granted repository roots.'},timeoutMs:{type:'integer',minimum:100,maximum:2147483647}},required:['cmd'],additionalProperties:false},
    execute(args,signal){
      const operation=(async()=>{
        invariant(!closed,'TURN_STOPPED','Repository execution is closed.');
        const parsed=commandSchema.parse(args),combined=AbortSignal.any([input.signal,signal,stop.signal,AbortSignal.timeout(parsed.timeoutMs)]);combined.throwIfAborted();
        const current=await nativeRepositoryRoots(input.cwd,paths,combined,input.repositoryAccess?.workspaceDirectory);
        invariant(JSON.stringify(current.map(canonical).sort())===JSON.stringify(rootKeys),'REPOSITORY_IDENTITY_CHANGED','Repository identity changed during this execution.');
        const cwd=await realpath(parsed.cwd?path.resolve(input.cwd,parsed.cwd):input.cwd),key=canonical(cwd);
        invariant(rootKeys.some(root=>key===root||key.startsWith(root+path.sep)),'REPOSITORY_SCOPE','Command cwd is outside the granted repositories.');
        combined.throwIfAborted();
        const command=await sandboxCommand(roots,cwd,parsed.cmd,input.repositoryAccess?.protectedPaths,{home:input.repositoryAccess?.shellHome,resources:input.repositoryAccess?.skillResources,signal:combined});
        combined.throwIfAborted();
        const child=subprocess.spawn({argv:command,cwd,env,signal:combined,graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:131072},stderr:{maxBytes:131072}}});active.add(child);
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
