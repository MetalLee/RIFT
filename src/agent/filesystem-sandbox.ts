import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../contracts/index.js';
import { containsPath } from '../api/workspace-paths.js';

export const privateEntry = (name:string) => /^(?:\.rift|\.runtime-evidence|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.env(?:\..*)?|management\.token|endpoint\.json|credentials(?:\..*)?|auth\.json)$/i.test(name);
/** A mount namespace, not a path-name/command filter. No project parent, user
 * home, Host /proc, network, credentials or inherited environment is exposed. */
export async function sandboxCommand(roots:readonly string[],cwd:string,cmd:string,protectedPaths:readonly string[]=[]):Promise<string[]> {
  invariant(process.platform==='linux','FILESYSTEM_ISOLATION_UNAVAILABLE','Repository commands require the verified Linux mount-namespace sandbox.');
  const binary='/usr/bin/bwrap';await lstat(binary);
  const sorted=[...new Set(roots)].sort((a,b)=>a.length-b.length);
  const unique=sorted.filter(root=>!sorted.some(parent=>parent!==root&&containsPath(parent,root)) || sorted.some(parent=>parent!==root&&containsPath(parent,root)&&(path.relative(parent,root).split(path.sep).some(privateEntry)||protectedPaths.some(secret=>containsPath(parent,secret)&&containsPath(secret,root)))));
  let effectiveProtected:readonly string[]=[];
  let masks:{path:string;directory:boolean}[]=[];
  const mounts:{root:string;masks:typeof masks}[]=[];
  let count=0;
  const inspect=async(directory:string):Promise<void>=>{
    for(const entry of await readdir(directory,{withFileTypes:true})){
      invariant(++count<=500000,'FILESYSTEM_SCAN_LIMIT','Workspace tree is too large to validate its filesystem boundary.');
      const file=path.join(directory,entry.name),info=await lstat(file);
      if(effectiveProtected.some(root=>containsPath(root,file))||privateEntry(entry.name)){masks.push({path:file,directory:info.isDirectory()});continue;}
      // Symlinks can reach only mounted data; the sandbox masks sensitive paths.
      if(info.isSymbolicLink())continue;
      invariant(!info.isFile()||info.nlink===1,'FILESYSTEM_HARDLINK','A multiply-linked file could mutate or expose data outside the workspace. Copy it to a private inode first.');
      invariant(info.isFile()||info.isDirectory(),'FILESYSTEM_SPECIAL_FILE','Workspace contains a device, socket or other special file.');
      if(info.isDirectory())await inspect(file);
    }
  };
  for(const root of unique){
    effectiveProtected=protectedPaths.filter((secret,index)=>index!==0||!containsPath(path.join(secret,'workspaces'),root));
    masks=[];
    invariant(path.isAbsolute(root)&&await realpath(root)===root&&root!==path.parse(root).root,'FILESYSTEM_SCOPE','Mount roots must be canonical project directories.');
    invariant(!['/usr','/bin','/sbin','/lib','/lib64','/etc','/proc','/dev','/sys'].some(system=>containsPath(system,root)||containsPath(root,system)),'FILESYSTEM_SCOPE','System directories are not project capabilities.');
    invariant(!effectiveProtected.some(secret=>containsPath(secret,root)),'FILESYSTEM_SCOPE','Host state cannot be mounted as project data.');
    await inspect(root);
    mounts.push({root,masks});
  }
  const args=[binary,'--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv'];
  for(const system of ['/usr','/bin','/sbin','/lib','/lib64']){
    try{const info=await lstat(system);if(info.isSymbolicLink())args.push('--symlink',path.relative('/',await realpath(system)),system);else args.push('--ro-bind',system,system);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/home/rift');
  for(const mount of mounts){
    args.push('--bind',mount.root,mount.root);
    for(const mask of mount.masks)args.push(...mask.directory?['--tmpfs',mask.path]:['--ro-bind','/dev/null',mask.path]);
  }
  args.push('--setenv','HOME','/home/rift','--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--setenv','LANG','C.UTF-8','--setenv','GIT_CONFIG_NOSYSTEM','1','--setenv','GIT_TERMINAL_PROMPT','0','--chdir',cwd,'--','/bin/bash','--noprofile','--norc','-c',cmd);
  return args;
}
