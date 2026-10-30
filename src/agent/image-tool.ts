import { constants } from 'node:fs';
import { open, realpath, readlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { invariant } from '../contracts/index.js';
import { privateEntry } from './filesystem-sandbox.js';
import { redact } from '../api/security.js';
import type { RuntimeTool } from './runtime-types.js';

const schema=z.object({path:z.string().min(1).max(4096)}).strict();
const MAX_BYTES=10*1024*1024;
interface ImageResult { kind:'rift-image'; mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif'; data:string; name:string }
function isImage(value:unknown):value is ImageResult {return !!value&&typeof value==='object'&&'kind' in value&&value.kind==='rift-image';}

/** Host-selected roots only. Read a regular raster file, never execute or write it. */
export function createImageTool(roots:string[]):RuntimeTool {
  const inside=(root:string,target:string)=>{const rel=path.relative(root,target);return !path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!rel.split(path.sep).some(p=>p.toLowerCase()==='.git'||privateEntry(p));};
  return {name:'rift_view_image',description:'View a local PNG, JPEG, WebP or GIF as an image (not text). Read-only; max 10 MiB. Use a relative path in the assigned directory or an absolute path within an assigned repository/workspace. Does not capture screenshots or execute commands.',inputSchema:z.toJSONSchema(schema),execute:async(args,signal)=>{
    signal.throwIfAborted();const input=schema.parse(args);
    invariant(!input.path.includes('\0')&&!input.path.split(/[\\/]/).some(p=>p==='..'),'UNAUTHORIZED','Image path must remain inside the assigned roots.');
    const bases=await Promise.all([...new Set(roots)].map(root=>realpath(root)));
    invariant(bases.length,'UNAUTHORIZED','No image read root is assigned.');
    const lexical=path.resolve(bases[0]!,input.path);
    invariant(bases.some(root=>inside(root,lexical)),'UNAUTHORIZED','Image path is outside assigned roots.');
    const actual=await realpath(lexical);
    invariant(bases.some(root=>inside(root,actual)),'UNAUTHORIZED','Image symlink leaves assigned roots.');
    const file=await open(actual,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try{
      const opened=process.platform==='linux'?await readlink('/proc/self/fd/'+file.fd):actual;
      invariant(bases.some(root=>inside(root,opened)),'UNAUTHORIZED','Opened image escaped assigned roots.');
      const stat=await file.stat();invariant(stat.isFile()&&stat.size>0&&stat.size<=MAX_BYTES,'INVALID_INPUT','Image must be a regular file of at most 10 MiB.');
      const buffer=Buffer.alloc(stat.size+1);const {bytesRead}=await file.read(buffer,0,buffer.length,0);
      invariant(bytesRead===stat.size,'INVALID_INPUT','Image changed during read.');
      const bytes=buffer.subarray(0,bytesRead);
      const mediaType=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':undefined;
      invariant(mediaType,'INVALID_INPUT','Expected PNG, JPEG, WebP or GIF bytes.');
      signal.throwIfAborted();invariant(await realpath(lexical)===actual,'UNAUTHORIZED','Image path changed during read.');
      return {kind:'rift-image',mediaType,data:bytes.toString('base64'),name:path.basename(actual)} satisfies ImageResult;
    }finally{await file.close();}
  }};
}

/** Persist image bytes before a DSH tool result is committed to its session. */
export async function prepareDshToolResult(ctx:Context,value:unknown):Promise<unknown> {
  if(!isImage(value))return value;
  const attachments=ctx.get('attachments');
  invariant(attachments,'IMAGE_STORAGE_UNAVAILABLE','Image attachment storage is not configured.');
  const attachment=await attachments.saveImage({data:Buffer.from(value.data,'base64'),mediaType:value.mediaType,name:value.name});
  return {kind:'rift-image-content',content:[{type:'image',attachment}]};
}
export function renderDshToolResult(value:unknown):ContentBlock[] {
  if(value&&typeof value==='object'&&'kind' in value&&value.kind==='rift-image-content'&&'content' in value)return value.content as ContentBlock[];
  return [{type:'text',text:redact(JSON.stringify(value??null))}];
}
export function renderNativeToolResult(value:unknown) {
  return isImage(value)?[{type:'inputImage',imageUrl:`data:${value.mediaType};base64,${value.data}`}]:[{type:'inputText',text:redact(JSON.stringify(value??null),256*1024)}];
}
