import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createRepositoryShell} from '../../src/agent/repository-shell.js';
import {agentSandboxMode} from '../../src/agent/sandbox-mode.js';
import type {Context} from '@deepseek-ai/cordis';
import type {SubprocessSpawnSpec} from '@deepseek-ai/dsh-subprocess';
afterEach(()=>vi.unstubAllEnvs());
describe('operator unrestricted mode',()=>{
  it('defaults to sandboxed and validates the explicit operator setting',()=>{
    vi.stubEnv('RIFT_AGENT_SANDBOX',undefined);expect(agentSandboxMode()).toBe('sandboxed');
    vi.stubEnv('RIFT_AGENT_SANDBOX','unrestricted');expect(agentSandboxMode()).toBe('unrestricted');
    vi.stubEnv('RIFT_AGENT_SANDBOX','typo');expect(()=>agentSandboxMode()).toThrow(/sandboxed or unrestricted/);
  });
  it.skipIf(process.platform!=='linux'||!existsSync('/usr/bin/bwrap'))('really reads SDK-shaped modules, reaches Host loopback and runs bwrap without an outer namespace',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'rift-unrestricted-')),own=path.join(root,'own'),outside=path.join(root,'outside');
    await mkdir(own);await mkdir(outside);await writeFile(path.join(outside,'credentials.mjs'),'export const marker="SDK_MODULE_OK";');
    const server=createServer((_req,res)=>res.end('HOST_NETWORK_OK'));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    const subprocess={spawn(spec:SubprocessSpawnSpec){
      const child=spawn(spec.argv[0]!,spec.argv.slice(1),{cwd:spec.cwd,env:spec.env,signal:spec.signal,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      const done=new Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on('error',reject);child.on('close',(exitCode,signal)=>resolve({exitCode,signal}));});
      return {done,terminate(){if(child.exitCode===null)child.kill();},async waitForExit(){await done;return true;},collected:{stdout:{readFrom:()=>({text:stdout,lossy:false})},stderr:{readFrom:()=>({text:stderr,lossy:false})}}};
    }} as unknown as Context['subprocess'];
    const shell=await createRepositoryShell(subprocess,{cwd:own,repositoryAccess:{repositoryPaths:[],workspaceDirectory:own,sandboxMode:'unrestricted'},signal:new AbortController().signal});
    try{
      const command=`set -eu; node --input-type=module -e 'import {marker} from "./credentials.mjs";console.log(marker);console.log(await (await fetch("http://127.0.0.1:${port}")).text())'; /usr/bin/bwrap --unshare-all --die-with-parent --cap-drop ALL --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev -- /usr/bin/echo BWRAP_OK`;
      const result=await shell.tool.execute({cmd:command,cwd:outside},new AbortController().signal);
      expect(result).toMatchObject({exitCode:0,stdout:'SDK_MODULE_OK\nHOST_NETWORK_OK\nBWRAP_OK\n',stderr:''});
    }finally{await shell.dispose();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await rm(root,{recursive:true,force:true});}
  });
});
