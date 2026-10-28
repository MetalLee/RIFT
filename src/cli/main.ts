#!/usr/bin/env node
import { workspaceCommandHelp } from './workspace-commands.js';
import { parseArgs } from 'node:util';
import { readFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { publicError } from '../api/security.js';
import { RiftError } from '../contracts/index.js';

const help = `RIFT 0.1.0 — local DSH plugin management
  rift serve [--profile rift] [--home PATH] [--port 47831] [--patch PATH] [--tailscale-ip IP]
  rift ui [--home PATH] [--remote]
  rift doctor [--json]
  rift workspace create --name NAME [--repo PATH --base REF] [--file workspace.json]
  rift workspace list | overview
  rift connection list
  rift connection create --file connection.json [--api-key-file SECRET_FILE]
  rift connection verify|delete ID
  rift workspace archive ID
  rift role configure --workspace ID --file roles.json
  rift run --workspace ID --goal TEXT [--no-lead]
  rift plan --workflow ID --file plan.json
  rift replan --workflow ID --file replan.json
  rift status --workflow ID
  rift logs --run ID
  rift cancel --run ID | --task ID | --workflow ID
  rift retry --task ID --reason TEXT [--version N]
  rift pause|resume --workflow ID [--version N]
  rift lead --workflow ID
  rift report --workflow ID
  rift ws <resource> <action> [id] --workspace ID [--data JSON | --file FILE]
  rift ws --help
All commands accept --home PATH and --json. Writes accept --key KEY for repeatable requests.
serve owns its DSH Host; other commands only connect to that Host.
See docs/e1-acceptance.md for current E1 verification and provider coverage.`;
function readArgs() { try { return parseArgs({allowPositionals:true,options:{home:{type:'string'},profile:{type:'string'},port:{type:'string'},patch:{type:'string'},'ui-dist':{type:'string'},'tailscale-ip':{type:'string'},remote:{type:'boolean'},name:{type:'string'},repo:{type:'string'},base:{type:'string'},workspace:{type:'string'},workflow:{type:'string'},run:{type:'string'},task:{type:'string'},goal:{type:'string'},file:{type:'string'},'api-key-file':{type:'string'},reason:{type:'string'},version:{type:'string'},key:{type:'string'},data:{type:'string'},json:{type:'boolean'},help:{type:'boolean'},'no-lead':{type:'boolean'}}}); } catch(error) { console.error(JSON.stringify({error:publicError(error)})); process.exit(1); } }
const args=readArgs();
const home=path.resolve(args.values.home??process.env.RIFT_HOME??'.rift');
const required=(name:keyof typeof args.values):string=>{const value=args.values[name];if(typeof value!=='string'||!value)throw new RiftError('MISSING_ARGUMENT',`--${name} is required.`);return value;};
async function request(method:string,route:string,body?:unknown):Promise<any>{
  const endpoint=JSON.parse(await readFile(path.join(home,'endpoint.json'),'utf8')) as {url:string};
  const url=new URL(endpoint.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new RiftError('INVALID_ENDPOINT','Management endpoint must be HTTP loopback.');
  const token=(await readFile(path.join(home,'management.token'),'utf8')).trim();
  const response=await fetch(`${url.origin}${route}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(method!=='GET'?{'Idempotency-Key':args.values.key??randomUUID()}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(35000)});
  const value=await response.json() as {error?:{code:string;message:string}};
  if(!response.ok)throw new RiftError(value.error?.code??'HTTP_ERROR',value.error?.message??`HTTP ${response.status}`);return value;
}
function parseJson(text:string):any {
  try{return JSON.parse(text);}catch{throw new RiftError('INVALID_JSON','Input must be valid JSON.');}
}
async function jsonInput():Promise<Record<string,unknown>> {
  if(args.values.data&&args.values.file)throw new RiftError('INVALID_INPUT','Choose --data or --file.');
  const input=parseJson(args.values.data??(args.values.file?await readFile(args.values.file,'utf8'):'{}'));
  if(!input||typeof input!=='object'||Array.isArray(input))throw new RiftError('INVALID_INPUT','Input must be a JSON object.');
  return input;
}
async function main():Promise<unknown>{
  const [command,subcommand,operand]=args.positionals;
  if(args.values['api-key-file']&&!(command==='connection'&&subcommand==='create'))throw new RiftError('INVALID_INPUT','--api-key-file is only valid for connection create.');
  if(command==='ws'){
    if(args.values.help||!subcommand)return workspaceCommandHelp();
    if(args.positionals.length>4)throw new RiftError('INVALID_INPUT','Use resource action and at most one object id.');
    const input=await jsonInput();
    return request('POST',`/v1/workspaces/${encodeURIComponent(required('workspace'))}/cli`,{argv:args.positionals.slice(1),input});
  }
  if(args.values.help||!command){console.log(help);return;}
  if(command==='ui')return request('POST','/v1/ui/bootstrap',args.values.remote?{remote:true}:{});
  if(command==='serve'){
    if(args.values['tailscale-ip'])process.env.RIFT_TAILSCALE_IP=args.values['tailscale-ip'];
    if(args.values['ui-dist'])process.env.RIFT_UI_DIST=path.resolve(args.values['ui-dist']);
    await mkdir(home,{recursive:true});process.env.RIFT_HOME=home;process.env.RIFT_PORT=args.values.port??process.env.RIFT_PORT??'47831';process.env.DSH_HOME??=path.join(home,'dsh');
    const profile=args.values.profile??'rift';if(!/^[A-Za-z0-9_-]+$/.test(profile))throw new RiftError('INVALID_PROFILE','Use a simple profile name.');
    const {initializeProfileFromDefault,runProfile}=await import('@deepseek-ai/dsh/profile-boot');
    const {loadLayeredEnv}=await import('@deepseek-ai/dsh-app-boot');
    if(!existsSync(path.join(process.env.DSH_HOME,'profiles',profile,'package.json')))initializeProfileFromDefault(profile,'sdk-minimal',process.env.DSH_HOME);
    const root=fileURLToPath(new URL('../..',import.meta.url));
    const patch=args.values.patch?path.resolve(args.values.patch):path.join(root,'profiles','rift.patch.yml');
    await access(patch);
    await runProfile({environment:loadLayeredEnv('rift'),profile,patchFiles:[patch],args:[]});
    return {status:'listening',home,profile,endpoint:JSON.parse(await readFile(path.join(home,'endpoint.json'),'utf8')),ownership:'This process owns the DSH Host. Ctrl+C stops its owned activations.'};
  }
  if(command==='doctor'&&!existsSync(path.join(home,'endpoint.json')))return{version:'0.1.0',node:process.version,dsh:'0.2.1-rc.3',host:'not-started',deepseekConfigured:Boolean(process.env.DEEPSEEK_API_KEY),claudeApiKeyConfigured:Boolean(process.env.ANTHROPIC_API_KEY),nativeAuthentication:'not-verified',next:'rift serve'};
  if(command==='doctor')return request('GET','/v1/doctor');
  if(command==='connection'){
    if(args.positionals.length>3)throw new RiftError('INVALID_INPUT','Use connection action and at most one id.');
    if(subcommand==='list'&&!operand)return request('GET','/v1/connections');
    if(subcommand==='create'&&!operand){
      const input=await jsonInput();
      if(input.apiKey!==undefined&&!args.values.file)throw new RiftError('INVALID_INPUT','Read credentials from --file or --api-key-file, not command-line JSON.');
      if(args.values['api-key-file']){
        if(input.apiKey!==undefined||input.credentialRef!==undefined)throw new RiftError('INVALID_INPUT','Choose a key file or one credential field.');
        input.apiKey=(await readFile(args.values['api-key-file'],'utf8')).trim();
      }
      return request('POST','/v1/connections',input);
    }
    if(operand&&(subcommand==='verify'||subcommand==='delete'))return request(subcommand==='verify'?'POST':'DELETE',`/v1/connections/${encodeURIComponent(operand)}${subcommand==='verify'?'/verify':''}`,{});
  }
  if(command==='workspace'){
    if(subcommand==='list')return request('GET','/v1/workspaces');
    if(subcommand==='overview')return request('GET','/v1/workspace-summaries');
    if(subcommand==='create')return request('POST','/v1/workspaces',{...await jsonInput(),...(args.values.name?{name:args.values.name}:{}),...(args.values.repo?{repositoryPath:path.resolve(args.values.repo)}:{}),...(args.values.base?{baseRef:args.values.base}:{})});
    if(subcommand==='archive'&&operand)return request('POST',`/v1/workspaces/${encodeURIComponent(operand)}/archive`,{});
  }
  if(command==='role'&&subcommand==='configure')return request('PUT',`/v1/workspaces/${encodeURIComponent(required('workspace'))}/roles`,parseJson(await readFile(required('file'),'utf8')));
  if(command==='run')return request('POST','/v1/workflows',{workspaceId:required('workspace'),goal:required('goal'),startLead:!args.values['no-lead']});
  if(command==='plan'||command==='replan')return request('POST',`/v1/workflows/${encodeURIComponent(required('workflow'))}/${command}`,parseJson(await readFile(required('file'),'utf8')));
  if(command==='status')return request('GET',`/v1/workflows/${encodeURIComponent(required('workflow'))}`);
  if(command==='logs')return request('GET',`/v1/runs/${encodeURIComponent(required('run'))}/logs`);
  if(command==='report')return request('GET',`/v1/workflows/${encodeURIComponent(required('workflow'))}/report`);
  if(command==='lead')return request('POST',`/v1/workflows/${encodeURIComponent(required('workflow'))}/lead`,{});
  if(command==='cancel'){
    const targets=(['run','task','workflow'] as const).filter(name=>args.values[name]);if(targets.length!==1)throw new RiftError('MISSING_ARGUMENT','Select exactly one --run, --task or --workflow.');const target=targets[0];return request('POST',`/v1/${target}s/${encodeURIComponent(required(target))}/cancel`,{});
  }
  if(command==='retry'){
    const id=required('task'),task=await request('GET',`/v1/tasks/${encodeURIComponent(id)}`);return request('POST',`/v1/tasks/${encodeURIComponent(id)}/retry`,{expectedVersion:args.values.version?Number(args.values.version):task.version,reason:required('reason')});
  }
  if(command==='pause'||command==='resume'){
    const id=required('workflow'),status=await request('GET',`/v1/workflows/${encodeURIComponent(id)}`);return request('POST',`/v1/workflows/${encodeURIComponent(id)}/${command}`,{expectedVersion:args.values.version?Number(args.values.version):status.workflow.version});
  }
  throw new RiftError('UNKNOWN_COMMAND',help);
}
try{const value=await main();if(value!==undefined)console.log(JSON.stringify(value,null,args.values.json?undefined:2));}catch(error){console.error(JSON.stringify({error:publicError(error)}));process.exitCode=1;}
