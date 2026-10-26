/** Real OS sandbox shell, Git metadata, multi-repository and cancellation probe. */
import path from 'node:path';
import { mkdir,mkdtemp,writeFile,access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeProfileFromDefault,runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { createRepositoryShell } from '../src/agent/repository-shell.js';
import { publicError } from '../src/api/security.js';

const exec=promisify(execFile),root=path.resolve('.runtime-evidence');await mkdir(root,{recursive:true});
const folder=await mkdtemp(path.join(root,'repository-shell-')),first=path.join(folder,'first'),second=path.join(folder,'second'),tree=path.join(folder,'linked');
const git=async(cwd:string,args:string[])=>(await exec('git',['-C',cwd,...args],{windowsHide:true})).stdout.trim();
for(const repo of [first,second]){await mkdir(repo);await git(repo,['init','-q','-b','main']);await git(repo,['config','user.name','RIFT probe']);await git(repo,['config','user.email','rift-probe@example.invalid']);await writeFile(path.join(repo,'base.txt'),'base');await git(repo,['add','.']);await git(repo,['commit','-qm','base']);}
await git(first,['worktree','add','-q','-b','shell-probe',tree]);
process.env.DSH_HOME=path.join(folder,'dsh');process.env.RIFT_HOME=path.join(folder,'rift');process.env.RIFT_PORT='0';initializeProfileFromDefault('shell-probe','sdk-minimal',process.env.DSH_HOME);
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('shell-probe'),profile:'shell-probe',patchFiles:[path.resolve('profiles/rift.patch.yml')],args:[]});
const checks:Record<string,boolean>={},report:Record<string,unknown>={date:new Date().toISOString(),mode:'real pinned OS sandbox and DSH subprocess; no inference, remote push or PR',folder};
const exists=async(file:string)=>{try{await access(file);return true;}catch{return false;}};
const quote=(p:string)=>`'${p.replaceAll("'","''")}'`;
let shell:Awaited<ReturnType<typeof createRepositoryShell>>|undefined;
try{
  const signal=new AbortController().signal,input={cwd:tree,repositoryAccess:{repositoryPaths:[first,second]},signal};
  shell=await createRepositoryShell(ctx.subprocess,input);
  const before=await git(tree,['rev-parse','HEAD']);
  const run=async(cmd:string,cwd?:string)=>await shell!.tool.execute({cmd,...cwd?{cwd}:{}},signal) as {exitCode:number;stdout:string;stderr:string};
  const primary=await run("Set-Content native.txt 'native shell'; git add native.txt; if ($LASTEXITCODE -ne 0) { throw 'add' }; git commit -m 'shell commit'; if ($LASTEXITCODE -ne 0) { throw 'commit' }");
  checks.worktreeCommit=primary.exitCode===0&&await git(tree,['rev-parse','HEAD'])!==before;
  const other=await run("Set-Content second.txt 'second repository'; git add second.txt; git commit -m 'second commit'; if ($LASTEXITCODE -ne 0) { throw 'commit' }",second);checks.secondRepositoryCommit=other.exitCode===0&&await exists(path.join(second,'second.txt'));
  const outside=path.join(folder,'outside.txt'),attempt=await run(`try { Set-Content -LiteralPath ${quote(outside)} -Value 'forbidden' -ErrorAction Stop; 'ALLOWED' } catch { 'DENIED' }`);checks.outsideWriteDenied=!await exists(outside)&&attempt.stdout.includes('DENIED');
  try{await run('pwd',folder);checks.outsideCwdDenied=false;}catch{checks.outsideCwdDenied=true;}
  const gh=await run('gh --version');checks.ghAvailable=gh.exitCode===0&&gh.stdout.includes('gh version');
  const cancelled=new AbortController();const hanging=shell.tool.execute({cmd:'Start-Sleep -Seconds 60',timeoutMs:60000},cancelled.signal);setTimeout(()=>cancelled.abort(),500);try{await hanging;checks.cancelledCommandSettled=false;}catch{checks.cancelledCommandSettled=true;}
  await shell.dispose();
  report.commands={primary,other,outside:attempt,gh};report.checks=checks;report.passed=Object.values(checks).every(Boolean);if(!report.passed)process.exitCode=1;
}catch(error){report.error=publicError(error);report.checks=checks;report.passed=false;process.exitCode=1;}finally{await shell?.dispose();await shutdown.shutdown(report.passed?0:1);await writeFile('docs/evidence/repository-shell-probe.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks,error:report.error}));}
