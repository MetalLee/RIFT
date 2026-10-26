/** Independent regression evidence: never equate a sandbox flag with network denial. */
import path from 'node:path';
import http from 'node:http';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { initializeProfileFromDefault,runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { nativeCodexPackage } from '../src/agent/native-codex.js';
import { gitOk } from '../src/git/process.js';

await mkdir('.runtime-evidence',{recursive:true});
const folder=await mkdtemp(path.resolve('.runtime-evidence/readonly-network-review-')),repo=path.join(folder,'repo');await mkdir(repo);
await gitOk(repo,['init','-q','-b','main']);await gitOk(repo,['-c','user.name=Review','-c','user.email=review@example.invalid','commit','--allow-empty','-qm','base']);
let received=0;const server=http.createServer((_req,res)=>{received++;res.end('independent local network reached');});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as import('node:net').AddressInfo).port;
process.env.DSH_HOME=path.join(folder,'dsh');process.env.RIFT_HOME=path.join(folder,'rift');process.env.RIFT_PORT='0';
initializeProfileFromDefault('readonly-network-review','sdk-minimal',process.env.DSH_HOME);
const {ctx,shutdown}=await runProfile({environment:loadLayeredEnv('readonly-network-review'),profile:'readonly-network-review',patchFiles:[path.resolve('profiles/rift.patch.yml')],args:[]});
const report:Record<string,unknown>={date:new Date().toISOString(),mode:'Independent real DSH native CLI readOnly sandbox; local GET and public HTTPS HEAD only; no remote writes',folder};
try{
  // Historical upstream sandbox diagnostic. Production formal modes no longer
  // expose a native shell; do not route this through the writable shell factory.
  const cmd=`try { Invoke-WebRequest -Uri 'http://127.0.0.1:${port}/probe' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null; 'LOCAL_ALLOWED' } catch { 'LOCAL_DENIED' }; try { Invoke-WebRequest -Uri 'https://github.com' -Method Head -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null; 'REMOTE_ALLOWED' } catch { 'REMOTE_DENIED' }`;
  const shell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=ctx.subprocess.spawn({argv:[...nativeCodexPackage().argv.slice(0,-2),'sandbox','-P','readonly_diagnostic','-c','permissions={readonly_diagnostic={filesystem={":root"="read"},network={enabled=false}}}','-c','windows.sandbox="unelevated"','-C',repo,'--',shell,'-NoLogo','-NoProfile','-NonInteractive','-Command',cmd],cwd:repo,signal:AbortSignal.timeout(20000),graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:8192},stderr:{maxBytes:8192}}});
  const result={...await child.done,stdout:child.collected.stdout?.readFrom(0).text??'',stderr:child.collected.stderr?.readFrom(0).text??''};child.terminate();await child.waitForExit(AbortSignal.timeout(10000));report.result=result;report.localRequests=received;
  report.localDenied=received===0&&result.stdout.includes('LOCAL_DENIED');report.remoteDenied=result.stdout.includes('REMOTE_DENIED');report.networkIsolationVerified=report.localDenied&&report.remoteDenied;
}catch(error){report.error=String(error);report.networkIsolationVerified=false;}
finally{await shutdown.shutdown(0);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await writeFile('docs/evidence/repository-readonly-network-independent-review.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
