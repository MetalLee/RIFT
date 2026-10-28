import {describe,it,expect} from 'vitest';
import {createServer} from 'node:http';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import {ApiConnectionService} from '../../src/agent/connections.js';
import {RiftStore} from '../../src/storage/database.js';

describe.each(['claude-opus-5-5','deepseek-flash','gateway-model'])('saved %s route context capacity',(model)=>{
  it('does not impose a RIFT-specific 60-second idle watchdog or automatic replay',()=>{
    const store=new RiftStore();try{
      const service=new ApiConnectionService({} as Context,store,process.cwd());
      const profiles=(service as unknown as {profiles(connections:unknown[]):Record<string,Record<string,unknown>>}).profiles([{provider:'test',name:'test',protocol:'openai-completions',endpoint:'https://example.com/v1',credentialRef:'KEY',model:'test'}]);
      expect(profiles.test).not.toHaveProperty('streamIdleTimeoutMs');expect(profiles.test!.retryPolicy).toEqual({mode:'normal',maxRetries:0});
    }finally{store.close();}
  });
  it.each([82776,1000001,'upstream-error'] as const)('classifies %s using the registered capacity and real adapter',async input=>{
    const server=createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      const request=JSON.parse(body);expect(request.max_tokens ?? request.max_completion_tokens).toBe(128000);
      if(input==='upstream-error'){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'maximum context length exceeded',type:'invalid_request_error'}}));return;}
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      for(const chunk of [
        {choices:[{index:0,delta:{role:'assistant',content:'Review complete.'},finish_reason:null}]},
        {choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:input,completion_tokens:1495,total_tokens:input+1495}},
      ])res.write(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model,...chunk})}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const ctx=new Context(),store=new RiftStore(),fiber=await ctx.plugin(LlmRuntime);
    const service=new ApiConnectionService(ctx,store,process.cwd());
    process.env.RIFT_CONTEXT_TEST_KEY='local-fake-key';
    try{
      await service.initialize();
      const route=await service.create({name:'Context test',protocol:'openai-completions',endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,model,credentialRef:'RIFT_CONTEXT_TEST_KEY'});
      const info=await ctx.llm.resolveModelInfo(route.provider,route.model);
      expect(JSON.stringify(info)).toContain('1000000');
      expect(info.defaultMaxTokens).toBe(128000);
      const frames=[];
      for await(const frame of ctx.llm.stream({provider:route.provider,model:route.model,messages:[{role:'user',content:[{type:'text',text:'Review.'}]}]}))frames.push(frame);
      const finish=frames.find(frame=>frame.type==='finish');
      expect(finish).toMatchObject({type:'finish',reason:input===82776?{kind:'stop'}:{kind:'error',failure:{code:'CONTEXT_WINDOW_EXCEEDED'}}});
      expect(service.get(route.id)).toMatchObject({model,provider:route.provider});
    }finally{delete process.env.RIFT_CONTEXT_TEST_KEY;await service.close();await fiber.dispose();store.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
