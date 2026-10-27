import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { invariant } from '../contracts/index.js';
import { containsPath } from '../api/workspace-paths.js';

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
  let readOnlyPaths:string[]=[];
  const mounts:{root:string;masks:typeof masks;readOnlyPaths:string[]}[]=[];
  let count=0;
  const inspect=async(directory:string,readOnly=false):Promise<void>=>{
    for(const entry of await readdir(directory,{withFileTypes:true})){
      invariant(++count<=500000,'FILESYSTEM_SCAN_LIMIT','Workspace tree is too large to validate its filesystem boundary.');
      const file=path.join(directory,entry.name),info=await lstat(file);
      if(effectiveProtected.some(root=>containsPath(root,file))||privateEntry(entry.name)){masks.push({path:file,directory:info.isDirectory()});continue;}
      // Symlinks can reach only mounted data; the sandbox masks sensitive paths.
      if(info.isSymbolicLink())continue;
      // A hardlink is an authorized directory entry, not a path escape. Protect
      // its shared inode from writes rather than rejecting unrelated commands.
      // Read-only package/store mounts handle pnpm's tens of thousands of links
      // without exceeding the OS argument/mount limits.
      // Keep the node_modules container and tool caches writable: Vite/Vitest
      // create .vite-temp here. Package/store directories remain read-only.
      const dependencyDirectory=info.isDirectory()&&path.basename(directory)==='node_modules'&&!['.cache','.vite','.vite-temp'].includes(entry.name);
      if(!readOnly&&(dependencyDirectory||info.isFile()&&info.nlink>1))readOnlyPaths.push(file);
      invariant(info.isFile()||info.isDirectory(),'FILESYSTEM_SPECIAL_FILE','Workspace contains a device, socket or other special file.');
      if(info.isDirectory())await inspect(file,readOnly||dependencyDirectory);
    }
  };
  for(const root of unique){
    effectiveProtected=protectedPaths.filter((secret,index)=>index!==0||!containsPath(path.join(secret,'workspaces'),root));
    masks=[];readOnlyPaths=[];
    invariant(path.isAbsolute(root)&&await realpath(root)===root&&root!==path.parse(root).root,'FILESYSTEM_SCOPE','Mount roots must be canonical project directories.');
    invariant(!['/usr','/bin','/sbin','/lib','/lib64','/etc','/proc','/dev','/sys'].some(system=>containsPath(system,root)||containsPath(root,system)),'FILESYSTEM_SCOPE','System directories are not project capabilities.');
    invariant(!effectiveProtected.some(secret=>containsPath(secret,root)),'FILESYSTEM_SCOPE','Host state cannot be mounted as project data.');
    await inspect(root);
    mounts.push({root,masks,readOnlyPaths});
  }
  const args=[binary,'--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv'];
  for(const system of ['/usr','/bin','/sbin','/lib','/lib64']){
    try{const info=await lstat(system);if(info.isSymbolicLink())args.push('--symlink',path.relative('/',await realpath(system)),system);else args.push('--ro-bind',system,system);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  args.push('--dir','/etc','--ro-bind',sandboxLocalhostFile(),'/etc/hosts');
  args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/home/rift');
  for(const mount of mounts){
    args.push('--bind',mount.root,mount.root);
    for(const readOnlyPath of mount.readOnlyPaths)args.push('--ro-bind',readOnlyPath,readOnlyPath);
    for(const mask of mount.masks)args.push(...mask.directory?['--tmpfs',mask.path]:['--ro-bind','/dev/null',mask.path]);
  }
  args.push('--setenv','HOME','/home/rift','--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--setenv','LANG','C.UTF-8','--setenv','GIT_CONFIG_NOSYSTEM','1','--setenv','GIT_TERMINAL_PROMPT','0','--chdir',cwd,'--','/bin/bash','--noprofile','--norc','-c',cmd);
  return args;
}
