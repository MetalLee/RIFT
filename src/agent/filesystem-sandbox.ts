import { lstat, readdir, realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { invariant } from '../contracts/index.js';
import { containsPath } from '../api/workspace-paths.js';
import { sandboxEgress } from './sandbox-egress.js';
import { privatizeHardlink } from './private-workspace-file.js';

let localhostFile:string|undefined;
function sandboxLocalhostFile():string {
  if(!localhostFile){
    const directory=mkdtempSync(path.join(tmpdir(),'rift-sandbox-etc-'));
    const file=path.join(directory,'hosts');
    writeFileSync(file,'127.0.0.1 localhost\n::1 localhost\n',{mode:0o400});
    process.once('exit',()=>rmSync(directory,{recursive:true,force:true}));
    localhostFile=file;
  }
  return localhostFile;
}
const transientHomes=new Map<string,string>();
process.once('exit',()=>{for(const home of transientHomes.values())rmSync(home,{recursive:true,force:true});});
function transientHome(root:string){
  let home=transientHomes.get(root);if(!home){home=mkdtempSync(path.join(tmpdir(),'rift-shell-home-'));transientHomes.set(root,home);}return home;
}
export const privateEntry = (name:string) => /^(?:\.rift|\.runtime-evidence|\.ssh|\.aws|\.azure|\.gnupg|\.env(?:\..*)?|management\.token|endpoint\.json|credentials(?:\..*)?|auth\.json)$/i.test(name);
/** A mount namespace, not a path-name/command filter. No project parent, user
 * home, Host /proc, Host network, credentials or inherited environment is exposed. Public HTTP(S)
 * egress uses a validating Unix proxy capability; no Host TCP namespace is shared. */
export async function sandboxCommand(roots:readonly string[],cwd:string,cmd:string,protectedPaths:readonly string[]=[],options:{home?:string;resources?:string;signal?:AbortSignal}={}):Promise<string[]> {
  options.signal?.throwIfAborted();
  invariant(process.platform==='linux','FILESYSTEM_ISOLATION_UNAVAILABLE','Repository commands require the verified Linux mount-namespace sandbox.');
  const binary='/usr/bin/bwrap';await lstat(binary);
  const sorted=[...new Set(roots)].sort((a,b)=>a.length-b.length);
  const unique=sorted.filter(root=>!sorted.some(parent=>parent!==root&&containsPath(parent,root)) || sorted.some(parent=>parent!==root&&containsPath(parent,root)&&(path.relative(parent,root).split(path.sep).some(privateEntry)||protectedPaths.some(secret=>containsPath(parent,secret)&&containsPath(secret,root)))));
  invariant(unique.length>0,'FILESYSTEM_SCOPE','A workspace root is required.');
  let effectiveProtected:readonly string[]=[];
  let masks:{path:string;directory:boolean}[]=[];
  const mounts:{root:string;masks:typeof masks}[]=[];
  let count=0;
  const inspect=async(directory:string,root:string):Promise<void>=>{
    for(const entry of await readdir(directory,{withFileTypes:true})){
      options.signal?.throwIfAborted();
      invariant(++count<=500000,'FILESYSTEM_SCAN_LIMIT','Workspace tree is too large to validate its filesystem boundary.');
      const file=path.join(directory,entry.name),info=await lstat(file);
      if(options.resources&&containsPath(options.resources,file)||effectiveProtected.some(root=>containsPath(root,file))||privateEntry(entry.name)){masks.push({path:file,directory:info.isDirectory()});continue;}
      // Symlinks can reach only mounted data; the sandbox masks sensitive paths.
      if(info.isSymbolicLink())continue;
      // Package managers must update/remove dependencies. Give this workspace a
      // private inode instead of read-only bind mounts that break npm/pnpm.
      if(info.isFile()&&info.nlink>1)await privatizeHardlink(file,root,options.signal);
      invariant(info.isFile()||info.isDirectory(),'FILESYSTEM_SPECIAL_FILE','Workspace contains a device, socket or other special file.');
      if(info.isDirectory())await inspect(file,root);
    }
  };
  for(const root of unique){
    effectiveProtected=protectedPaths.filter((secret,index)=>index!==0||!containsPath(path.join(secret,'workspaces'),root));
    masks=[];
    invariant(path.isAbsolute(root)&&await realpath(root)===root&&root!==path.parse(root).root,'FILESYSTEM_SCOPE','Mount roots must be canonical project directories.');
    invariant(!['/usr','/bin','/sbin','/lib','/lib64','/etc','/proc','/dev','/sys'].some(system=>containsPath(system,root)||containsPath(root,system)),'FILESYSTEM_SCOPE','System directories are not project capabilities.');
    invariant(!effectiveProtected.some(secret=>containsPath(secret,root)),'FILESYSTEM_SCOPE','Host state cannot be mounted as project data.');
    await inspect(root,root);
    mounts.push({root,masks});
  }
  const home=options.home??transientHome(unique[0]!);
  await mkdir(home,{recursive:true,mode:0o700});
  invariant(path.isAbsolute(home)&&await realpath(home)===home,'FILESYSTEM_SCOPE','Shell home must be a canonical Host-provisioned directory.');
  effectiveProtected=protectedPaths.filter(secret=>!containsPath(secret,home));masks=[];await inspect(home,home);const homeMasks=masks;
  options.signal?.throwIfAborted();
  const egress=await sandboxEgress();
  options.signal?.throwIfAborted();
  const args=[binary,'--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv'];
  for(const system of ['/usr','/bin','/sbin','/lib','/lib64']){
    try{const info=await lstat(system);if(info.isSymbolicLink())args.push('--symlink',path.relative('/',await realpath(system)),system);else args.push('--ro-bind',system,system);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  args.push('--dir','/etc','--ro-bind',sandboxLocalhostFile(),'/etc/hosts');
  args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/home/rift');
  for(const mount of mounts){
    args.push('--bind',mount.root,mount.root);
    for(const mask of mount.masks)args.push(...mask.directory?['--tmpfs',mask.path]:['--ro-bind','/dev/null',mask.path]);
  }
  args.push('--bind',home,'/home/rift','--ro-bind',egress.directory,'/run/rift-egress');
  for(const mask of homeMasks){const target=path.join('/home/rift',path.relative(home,mask.path));args.push(...mask.directory?['--tmpfs',target]:['--ro-bind','/dev/null',target]);}
  if(options.resources){invariant(path.isAbsolute(options.resources)&&await realpath(options.resources)===options.resources,'FILESYSTEM_SCOPE','Resource root must be canonical.');args.push('--ro-bind',options.resources,options.resources);}
  // Public certificate roots only, not Host resolver/hosts/private configuration.
  try{await lstat('/etc/ssl/certs');args.push('--ro-bind','/etc/ssl/certs','/etc/ssl/certs');}catch{}
  const environment:Record<string,string>={HOME:'/home/rift',PATH:'/home/rift/.local/bin:/home/rift/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',npm_config_prefix:'/home/rift/.local',npm_config_cache:'/home/rift/.npm',COREPACK_HOME:'/home/rift/.cache/node/corepack',COREPACK_ENABLE_DOWNLOAD_PROMPT:'0',PNPM_HOME:'/home/rift/.local/share/pnpm',XDG_CACHE_HOME:'/home/rift/.cache',XDG_DATA_HOME:'/home/rift/.local/share',XDG_CONFIG_HOME:'/home/rift/.config'};
  for(const [name,value] of Object.entries(environment))args.push('--setenv',name,value);
  args.push('--chdir',cwd,'--','/usr/local/bin/node','/run/rift-egress/bootstrap.cjs',cmd);
  return args;
}
