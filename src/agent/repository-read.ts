import { constants } from 'node:fs';
import { privateEntry } from './filesystem-sandbox.js';
import { open, opendir, realpath, readlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { invariant } from '../contracts/index.js';
import { redact } from '../api/security.js';
import type { RuntimeTool } from './runtime-types.js';

const readInput=z.object({path:z.string().min(1).max(4096),offset:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),maxBytes:z.number().int().min(1).max(65536).default(65536)}).strict();
const listInput=z.object({path:z.string().min(1).max(4096).default('.'),limit:z.number().int().min(1).max(200).default(200)}).strict();

/** No shell or writable handles. Paths are resolved inside this Run's worktree,
 * including symlink targets; .git metadata and Windows alternate streams are excluded. */
export function createRepositoryReadTools(cwd:string):RuntimeTool[] {
  let root:Promise<string>|undefined;
  const inside=(base:string,path:string)=>{const rel=relative(base,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!rel.split(sep).some(part=>part.toLowerCase()==='.git'||privateEntry(part));};
  const locate=async(path:string)=>{
    invariant(!isAbsolute(path)&&!path.includes(':')&&!path.includes('\0')&&!path.split(/[\\/]/).some(part=>part==='..'||part.toLowerCase()==='.git'||privateEntry(part)),'UNAUTHORIZED','Use a relative path inside this analysis worktree, excluding .git.');
    const base=await(root??=realpath(cwd)),lexical=resolve(base,path),actual=await realpath(lexical);
    invariant(inside(base,actual),'UNAUTHORIZED','Analysis reads cannot leave their own worktree.');
    return{base,lexical,actual};
  };
  const unchanged=async(target:Awaited<ReturnType<typeof locate>>)=>{invariant(await realpath(cwd)===target.base&&await realpath(target.lexical)===target.actual,'UNAUTHORIZED','Analysis path changed during the read.');};
  return[
    {name:'rift_read_file',description:'Read UTF-8 source text inside this analysis Run worktree. Relative path only; no .git, writes, shell, or paths outside the worktree. At most 65536 bytes per call; use nextOffset for the next portion.',inputSchema:z.toJSONSchema(readInput,{io:'input'}),execute:async(args,signal)=>{
      const input=readInput.parse(args);signal.throwIfAborted();const target=await locate(input.path);signal.throwIfAborted();
      const file=await open(target.actual,constants.O_RDONLY | (constants.O_NOFOLLOW??0));
      try{if(process.platform==='linux')invariant(inside(target.base,await readlink(`/proc/self/fd/${file.fd}`)),'UNAUTHORIZED','Opened file escaped the assigned checkout.');const stat=await file.stat();invariant(stat.isFile(),'UNAUTHORIZED','Analysis reads require a regular file.');const buffer=Buffer.alloc(input.maxBytes),{bytesRead}=await file.read(buffer,0,buffer.length,input.offset);signal.throwIfAborted();await unchanged(target);invariant(!buffer.subarray(0,bytesRead).includes(0),'INVALID_INPUT','Only text files can be read by this analysis tool.');return{path:input.path,content:redact(buffer.subarray(0,bytesRead).toString('utf8')),offset:input.offset,nextOffset:input.offset+bytesRead,totalBytes:stat.size,truncated:input.offset+bytesRead<stat.size};}finally{await file.close();}
    }},
    {name:'rift_list_files',description:'List up to 200 direct entries in a relative directory inside this analysis Run worktree. Does not recurse, follow symlink entries, expose .git, write files, or run commands.',inputSchema:z.toJSONSchema(listInput,{io:'input'}),execute:async(args,signal)=>{
      const input=listInput.parse(args);signal.throwIfAborted();const target=await locate(input.path),entries:{name:string;type:string}[]=[];let truncated=false;
      const directory=await opendir(target.actual);
      for await(const entry of directory){signal.throwIfAborted();if(entry.name.toLowerCase()==='.git'||privateEntry(entry.name))continue;if(entries.length===input.limit){truncated=true;break;}entries.push({name:entry.name,type:entry.isSymbolicLink()?'symlink':entry.isDirectory()?'directory':entry.isFile()?'file':'other'});}
      signal.throwIfAborted();await unchanged(target);return{path:input.path,entries,truncated};
    }},
  ];
}
