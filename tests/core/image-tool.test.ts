import { describe,it,expect } from 'vitest';
import { mkdtemp,rm,writeFile,symlink,mkdir,readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createImageTool,prepareDshToolResult,renderDshToolResult,renderNativeToolResult } from '../../src/agent/image-tool.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=','base64');
describe('cross-runtime read-only image tool',()=>{
  it('returns native image content and durable DSH image attachments, never a JSON/base64 text dump',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'rift-image-'));
    try{
      await writeFile(path.join(root,'screen.png'),png);
      const value=await createImageTool([root]).execute({path:'screen.png'},new AbortController().signal);
      expect(renderNativeToolResult(value)).toEqual([{type:'inputImage',imageUrl:'data:image/png;base64,'+png.toString('base64')}]);
      let saved:unknown;
      const attachment={attachmentId:'test-image',mediaType:'image/png',bytes:png.length,width:1,height:1};
      const ctx={get:()=>({saveImage:async(input:unknown)=>{saved=input;return attachment;}})} as unknown as Context;
      const stored=await prepareDshToolResult(ctx,value),blocks=renderDshToolResult(stored);
      expect(saved).toEqual({data:png,mediaType:'image/png',name:'screen.png'});
      expect(blocks).toEqual([{type:'image',attachment}]);
      expect(JSON.stringify(stored)).not.toContain(png.toString('base64'));
      expect(await readFile(path.join(root,'screen.png'))).toEqual(png);
      expect(renderDshToolResult({ok:true})).toEqual([{type:'text',text:'{"ok":true}'}]);
      await expect(prepareDshToolResult({get:()=>undefined} as unknown as Context,value)).rejects.toMatchObject({code:'IMAGE_STORAGE_UNAVAILABLE'});
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('reads images in any directory inside the assigned task root, including hidden evidence directories',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'rift-image-any-directory-'));
    try{
      const tool=createImageTool([root]),signal=new AbortController().signal;
      for(const directory of ['.runtime-evidence/reviewer/screens','.rift/screens','.git/screens','.ssh/screens','.env/screens','credentials/screens','普通目录/截图']){
        await mkdir(path.join(root,directory),{recursive:true});
        const file=path.join(directory,'screen.png');await writeFile(path.join(root,file),png);
        for(const location of [file,path.join(root,file)]){
          const result=await tool.execute({path:location},signal);
          expect(renderNativeToolResult(result)).toEqual([{type:'inputImage',imageUrl:'data:image/png;base64,'+png.toString('base64')}]);
        }
        expect(await readFile(path.join(root,file))).toEqual(png);
      }
      await symlink(path.join(root,'.runtime-evidence'),path.join(root,'evidence-link'));
      expect(renderNativeToolResult(await tool.execute({path:'evidence-link/reviewer/screens/screen.png'},signal))[0]?.type).toBe('inputImage');
      await writeFile(path.join(root,'.env','secret.txt'),'not an image');
      await expect(tool.execute({path:'.env/secret.txt'},signal)).rejects.toMatchObject({code:'INVALID_INPUT'});
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('rejects escapes, fake images, oversize files, directories and aborted calls',async()=>{
    const base=await mkdtemp(path.join(os.tmpdir(),'rift-image-boundary-')),root=path.join(base,'root');
    try{
      await mkdir(root);await writeFile(path.join(base,'outside.png'),png);
      await symlink(path.join(base,'outside.png'),path.join(root,'escape.png'));
      await writeFile(path.join(root,'fake.png'),'not image bytes');await writeFile(path.join(root,'huge.png'),Buffer.alloc(10*1024*1024+1));
      const tool=createImageTool([root]),signal=new AbortController().signal;
      for(const file of ['../outside.png',path.join(base,'outside.png'),'escape.png','fake.png','huge.png','.'])await expect(tool.execute({path:file},signal)).rejects.toBeTruthy();
      const controller=new AbortController();controller.abort();await expect(tool.execute({path:'fake.png'},controller.signal)).rejects.toBeTruthy();
    }finally{await rm(base,{recursive:true,force:true});}
  });
});
