import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { ApiConnectionService } from '../../src/agent/connections.js';
import { RiftStore } from '../../src/storage/database.js';
import { ChatService } from '../../src/chat/service.js';
import { DshChatRuntime } from '../../src/chat/dsh-runtime.js';
import { seedWorkspace } from './fixtures.js';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};};
const until=async(check:()=>boolean)=>{for(let i=0;i<1000;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Real DSH streaming did not progress');};

// A deterministic local provider drives the real HTTP/SSE parser and DSH agent
// loop. No mocked agent frames or injected RuntimeEvents are used in this test.
describe('real DSH provider streaming and tool loop',()=>{
  it('streams Chinese and English commentary and final text while the provider request is still open',async()=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-dsh-live-stream-'));
    const previousHome=process.env.DSH_HOME;
    let reasoning='',commentary='',answer='',requests=0,gate=deferred<void>(),reasoningGate=deferred<void>();
    const server=http.createServer(async(req,res)=>{
      let source='';for await(const chunk of req)source+=chunk;
      const body=JSON.parse(source);requests++;
      expect(req.url).toBe('/v1/chat/completions');expect(body.stream).toBe(true);
      const afterTool=body.messages.some((message:{role:string})=>message.role==='tool');
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const send=(delta:unknown,reason:string|null=null)=>res.write(`data: ${JSON.stringify({id:'local-stream',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:reason}]})}\n\n`);
      send({role:'assistant'});
      if (!afterTool) {
        for (const character of reasoning) send({reasoning_content:character});
        await reasoningGate.promise;
      }
      for(const character of afterTool?answer:commentary)send({content:character});
      if(afterTool)await gate.promise;
      else send({tool_calls:[{index:0,id:'inspect-call',type:'function',function:{name:'inspect_repository',arguments:'{}'}}]});
      send({},afterTool?'stop':'tool_calls');res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    process.env.DSH_HOME=path.join(home,'dsh');initializeProfileFromDefault('live-stream','sdk-minimal',process.env.DSH_HOME);
    const patch=path.join(home,'headless.patch.yml');await writeFile(patch,'- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n');
    const runtime=await runProfile({environment:loadLayeredEnv('live-stream'),profile:'live-stream',patchFiles:[patch],args:[]});
    await runtime.ctx.plugin(LocalCredentialProvider,{path:path.join(home,'.credentials.yaml'),watch:false});
    const store=new RiftStore(),service=new ApiConnectionService(runtime.ctx,store,home);
    let chat:ChatService|undefined,tool=deferred<unknown>();
    try {
      await service.initialize();
      const connection=await service.create({name:'Local deterministic provider',protocol:'openai-completions',endpoint:`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`,model:'local-stream-model',apiKey:'local-test-key-not-a-real-credential'});
      const {workspace}=seedWorkspace(store,'dsh-stream');
      chat=new ChatService({store,home,defaultConnection:()=>({runtime:'dsh',provider:connection.provider,model:connection.model}),validateConnection(){},runtime:()=>new DshChatRuntime(runtime.ctx,connection.provider),tools:()=>[{name:'inspect_repository',description:'Inspect repository',inputSchema:{type:'object',properties:{},additionalProperties:false},execute:()=>tool.promise}]});
      for(const language of ['zh','en']) {
        reasoning=language==='zh'?'需要核对仓库中的实际文件。':'The repository files need to be checked.';
        commentary=language==='zh'?'我先检查仓库，然后验证输出。':'I will inspect the repository and verify streaming.';
        answer=language==='zh'?'检查完成，输出正常。':'Inspection complete. Streaming works.';
        gate=deferred<void>();reasoningGate=deferred<void>();tool=deferred<unknown>();
        const conversation=chat.createConversation(workspace.id,`Real DSH ${language}`);
        const turn=chat.send(workspace.id,conversation.id,{clientMessageId:`real-${language}`,content:`Inspect the repository (${language})`}).turn;
        await until(()=>!!chat!.turn(workspace.id,turn.id).streamMessages?.some(message=>message.kind==='reasoning'&&message.text===reasoning));
        const thinking=chat.turn(workspace.id,turn.id);
        expect(thinking.status).toBe('running');
        expect(thinking.streamMessages?.filter(message=>message.text).map(message=>message.kind)).toEqual(['reasoning']);
        reasoningGate.resolve();
        await until(()=>chat!.turn(workspace.id,turn.id).phase==='tool');
        const inTool=chat.turn(workspace.id,turn.id);
        expect(inTool.status).toBe('running');
        expect(inTool.streamMessages?.find(message=>message.kind==='commentary')).toMatchObject({text:commentary,status:'completed'});
        expect(inTool.activities?.some(activity=>activity.type==='tool.started')).toBe(true);
        tool.resolve({files:3});
        await until(()=>!!chat!.turn(workspace.id,turn.id).streamMessages?.some(message=>message.text===answer));
        const generating=chat.turn(workspace.id,turn.id);
        expect(generating.status).toBe('running');
        expect(generating.streamMessages?.at(-1)?.status).toBe('streaming');
        expect(generating.activities?.some(activity=>activity.type==='tool.completed')).toBe(true);
        gate.resolve();await until(()=>chat!.turn(workspace.id,turn.id).status==='completed');
        expect(chat.page(workspace.id,conversation.id).messages.filter(message=>message.role==='assistant').map(message=>message.content)).toEqual([answer]);
      }
      expect(requests).toBe(4);
    } finally {
      gate.resolve();reasoningGate.resolve();tool.resolve({});await chat?.close();await service.close();store.close();await runtime.shutdown.shutdown(0);
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
      if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;
      await rm(home,{recursive:true,force:true});
    }
  });
});
