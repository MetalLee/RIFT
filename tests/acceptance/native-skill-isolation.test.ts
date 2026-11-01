import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeCodexRuntime } from '../../src/agent/native-codex.js';
import type { RuntimeHandle } from '../../src/agent/runtime-types.js';

it('keeps local skills out of real native prompts on start/resume while retaining RIFT skill instructions and global preferences', async () => {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'rift-native-skills-')));
  const home=path.join(root,'home'), runtimeHome=path.join(home,'.codex'), cwd=path.join(root,'repo');
  await mkdir(runtimeHome,{recursive:true});await mkdir(cwd);
  const original='check_for_update_on_startup = false\n';await writeFile(path.join(runtimeHome,'config.toml'),original);
  const seed=async(directory:string,name:string)=>{await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'SKILL.md'),`---\nname: ${name}\ndescription: LOCAL_SKILL_SENTINEL_${name}\n---\nDo not inherit this local skill.\n`);};
  await seed(path.join(runtimeHome,'skills','local-codex'),'local-codex');
  await seed(path.join(home,'.agents','skills','local-user'),'local-user');
  await seed(path.join(cwd,'.agents','skills','local-repository'),'local-repository');
  const prompts:string[]=[], catalogs:string[][]=[];
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    prompts.push(Buffer.concat(chunks).toString());
    const item={type:'message',id:`msg_${prompts.length}`,role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'RIFT_SKILL_TEST_OK',annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(type:string,data:object)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    send('response.created',{response:{id:'response_test',status:'in_progress',output:[]}});
    send('response.output_item.added',{output_index:0,item});send('response.output_item.done',{output_index:0,item});
    send('response.completed',{response:{id:'response_test',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  let handle:RuntimeHandle|undefined,threadId:string|undefined;
  const runtime=new NativeCodexRuntime({env:{HOME:home},modelProvider:{id:'rift_skill_test',config:{name:'Local skill isolation test',base_url:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}},spawn(spec){
    const child=spawn(spec.argv[0]!,spec.argv.slice(1),{cwd:spec.cwd,env:{...process.env,...spec.env},stdio:['pipe','pipe','pipe']});
    child.stderr.resume();
    let output='';child.stdout.on('data',chunk=>{output+=chunk.toString();let end:number;while((end=output.indexOf('\n'))!==-1){const line=output.slice(0,end);output=output.slice(end+1);try{const message=JSON.parse(line);const skills=message.result?.data?.[0]?.skills;if(Array.isArray(skills))catalogs.push(skills.map((skill:{name:string})=>skill.name));}catch{/* Non-protocol output is handled by the runtime. */}}});
    const done=new Promise<{exitCode:number;signal:null}>(resolve=>child.on('close',code=>resolve({exitCode:code??1,signal:null})));
    return{stdin:child.stdin,stdout:child.stdout,stderr:undefined,control:undefined,collected:{},done,terminate(){child.kill();},async waitForExit(signal){return Promise.race([done.then(()=>true),new Promise<boolean>(resolve=>{if(signal?.aborted)resolve(false);else signal?.addEventListener('abort',()=>resolve(false),{once:true});})]);}};
  }});
  try{
    for(let turn=0;turn<2;turn++){
      if(turn)await seed(path.join(runtimeHome,'skills','new-local'),'new-local');
      handle=await runtime.start({workspaceId:'skills-test',agentId:'lead',turnId:String(turn),cwd,model:'gpt-6.1-sol',instructions:'RIFT_WORKSPACE_SKILL_SENTINEL: use the workspace shared rules.',messages:[{role:'user',content:'Reply briefly.'}],tools:[],session:{runtimeHome,threadId,onThread(id){threadId=id;},onTurn(){},onSettled(){}},signal:AbortSignal.timeout(20000)});
      expect((await handle.result).stopReason).toBe('completed');await handle.dispose();handle=undefined;
    }
    expect(catalogs).toHaveLength(2);
    expect(catalogs[0]).toContain('local-codex');expect(catalogs[1]).toContain('new-local');
    expect(prompts).toHaveLength(2);
    for(const prompt of prompts){expect(prompt).toContain('RIFT_WORKSPACE_SKILL_SENTINEL');expect(prompt).not.toContain('LOCAL_SKILL_SENTINEL');}
    expect(await readFile(path.join(runtimeHome,'config.toml'),'utf8')).toBe(original);
  }finally{await handle?.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
