import { constants } from 'node:fs';
import { open, rename, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { containsPath } from '../api/workspace-paths.js';
import { invariant } from '../contracts/index.js';

/** Detach only this workspace's directory entry. Both copy endpoints are held
 * descriptors, so a replaced pathname cannot redirect Host writes or reads. */
export async function privatizeHardlink(file:string,root:string,signal?:AbortSignal):Promise<void> {
 signal?.throwIfAborted();
 const directory=await open(path.dirname(file),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 const parent=`/proc/self/fd/${directory.fd}`,target=path.join(parent,path.basename(file));
 const temporary=path.join(parent,`.rift-copy-${randomUUID()}`);
 let source:Awaited<ReturnType<typeof open>>|undefined,destination:Awaited<ReturnType<typeof open>>|undefined;
 try{
  invariant(containsPath(root,await realpath(parent)),'FILESYSTEM_SCOPE','Copy parent moved outside workspace.');
  source=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await source.stat();
  invariant(before.isFile(),'FILESYSTEM_SPECIAL_FILE','Only regular files can be copied.');
  if(before.nlink===1)return;
  destination=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  const buffer=Buffer.allocUnsafe(Math.min(before.size||1,1024*1024));let offset=0;
  while(true){signal?.throwIfAborted();const {bytesRead}=await source.read(buffer,0,buffer.length,offset);if(!bytesRead)break;
    for(let written=0;written<bytesRead;){signal?.throwIfAborted();const result=await destination.write(buffer,written,bytesRead-written,offset+written);written+=result.bytesWritten;}offset+=bytesRead;
  }
  signal?.throwIfAborted();
  await destination.chmod(before.mode&0o777);await destination.utimes(before.atime,before.mtime);
  const current=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const now=await current.stat();invariant(now.dev===before.dev&&now.ino===before.ino&&containsPath(root,await realpath(parent)),'FILESYSTEM_CHANGED','Workspace file changed during preparation; retry.');}finally{await current.close();}
  signal?.throwIfAborted();await rename(temporary,target);
 }finally{await source?.close();await destination?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});await directory.close();}
}
