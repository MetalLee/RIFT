import {describe,it,expect} from 'vitest';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime, { createAssistantMessage, createToolResultMessage, ToolCallId, type RequestMessage } from '@deepseek-ai/dsh-llm';
import {ApiConnectionService} from '../../src/agent/connections.js';
import {RiftStore} from '../../src/storage/database.js';
import {createImageTool,prepareDshToolResult,renderDshToolResult} from '../../src/agent/image-tool.js';

describe.each(['user','tool'] as const)('saved API image transport through real DSH adapters (%s)',messageRole=>{
  it.each(['openai-completions','openai-responses','anthropic-messages'] as const)('sends image pixels through %s instead of a text-only placeholder',async protocol=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'rift-image-api-'));
    const requests:unknown[]=[];
    const server=createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
      // The probe verifies the outbound request, not generated model text.
      res.writeHead(400,{'Content-Type':'application/json'});
      res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Local image transport probe finished'}}));
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const ctx=new Context(),store=new RiftStore(),llm=await ctx.plugin(LlmRuntime);
    const require=createRequire(import.meta.url),dshRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
    const attachmentModule=await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-attachment-local')).href);
    const attachments=await ctx.plugin(attachmentModule.default,{dshHome:root});
    const service=new ApiConnectionService(ctx,store,root);
    process.env.RIFT_IMAGE_TEST_KEY='local-test-key';
    try{
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=','base64');await writeFile(path.join(root,'image.png'),png);
      const result=await prepareDshToolResult(ctx,await createImageTool([root]).execute({path:'image.png'},new AbortController().signal));
      const content=renderDshToolResult(result);
      expect(content[0]?.type).toBe('image');
      await service.initialize();
      const route=await service.create({name:'Image probe',protocol,endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,model:'test-vision',credentialRef:'RIFT_IMAGE_TEST_KEY'});
      const callId=ToolCallId('image-probe');
      const messages:RequestMessage[]=messageRole==='user'?[{role:'user',content}]:[
        {role:'user',content:[{type:'text',text:'Inspect the screenshot.'}]},
        createAssistantMessage({source:{provider:route.provider,model:route.model},content:[{type:'tool-call',id:callId,name:'rift_view_image',arguments:'{"path":"image.png"}'}]}),
        createToolResultMessage({callId,content,isError:false}),
      ];
      const frames=[];
      for await(const frame of ctx.llm.stream({provider:route.provider,model:route.model,messages,tools:[{name:'rift_view_image',description:'Read image',parameters:{type:'object',properties:{path:{type:'string'}}}}]}))frames.push(frame);
      expect(requests).toHaveLength(1);
      const body=JSON.stringify(requests[0]);
      expect(body).not.toContain('cannot accept');
      if(protocol==='openai-completions')expect(body).toContain('"type":"image_url"');
      else if(protocol==='openai-responses')expect(body).toContain('"type":"input_image"');
      else expect(body).toContain('"type":"image"');
      expect(body).toMatch(/base64/);
      expect(frames.some(frame=>frame.type==='finish')).toBe(true);
    }finally{delete process.env.RIFT_IMAGE_TEST_KEY;await service.close();await attachments.dispose();await llm.dispose();store.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
  });
});
