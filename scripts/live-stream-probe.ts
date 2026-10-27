import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RiftStore } from '../src/storage/database.js';
import { createWorkspace } from '../src/project/workspace.js';
import { configureRoles } from '../src/project/agent-roles.js';
import { ChatService } from '../src/chat/service.js';
import { startLocalApi } from '../src/api/local-api.js';
import { readWorkspaceEvents, type WorkspaceEvent } from '../src/events/workspace-events.js';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../src/agent/runtime-types.js';

const home=await mkdtemp(path.join(tmpdir(),'rift-stream-probe-'));
const store=new RiftStore();
const workspace=createWorkspace(store,{id:'stream-probe',name:'Stream probe',rootPath:home,repositoryPath:home,commonGitDir:path.join(home,'.git'),baseRef:'main'});
configureRoles(store,workspace.id,[{id:'probe-binding',providerName:'probe',packageVersion:'probe',configRevision:1,capabilities:{},credentialRefs:[]}],[{name:'lead',kind:'dsh-lead',prompt:'Stream',revision:1},{name:'developer-a',kind:'subagent',providerBindingId:'probe-binding',prompt:'Develop',revision:1},{name:'reviewer',kind:'subagent',providerBindingId:'probe-binding',prompt:'Review',revision:1}],new Set(['probe']));
let input:RuntimeTurnInput|undefined,finish!:(value:RuntimeTurnResult)=>void;
const model=new Promise<RuntimeTurnResult>(resolve=>{finish=resolve;});
const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'controlled'}),validateConnection(){},tools:()=>[],runtime:()=>({async start(value){input=value;return{result:model,dispose:async()=>{}};}})});
const api=await startLocalApi({handle:async()=>({}),browserEvents:(id,after)=>readWorkspaceEvents(store,id,after)},{home,port:0,uiEnabled:false});
const abort=new AbortController();
const result:{at:string;mode:string;samples:{language:string;latencyMs:number}[];p95Ms?:number;targetMs:number;passed?:boolean}={at:new Date().toISOString(),mode:'controlled runtime; actual SQLite and HTTP SSE delivery; excludes model inference and browser rendering',samples:[],targetMs:200};
try {
  const conversation=chat.createConversation(workspace.id,'Stream latency');
  chat.send(workspace.id,conversation.id,{clientMessageId:'probe',content:'Probe'});
  for(let i=0;!input&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));
  if(!input)throw new Error('Runtime did not start');
  const cursor=chat.page(workspace.id,conversation.id).snapshotCursor;
  const token=(await readFile(path.join(home,'management.token'),'utf8')).trim();
  const response=await fetch(`http://127.0.0.1:${api.port}/v1/workspaces/${workspace.id}/events?after=${cursor}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])});
  if(response.status!==200)throw new Error(`SSE returned ${response.status}`);
  const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
  async function nextDelta(id:string):Promise<WorkspaceEvent> {
    for(;;){
      const boundary=buffer.indexOf('\n\n');
      if(boundary>=0){
        const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        const line=frame.split('\n').find(value=>value.startsWith('data: '));
        if(!line||!frame.includes('event: workspace'))continue;
        const event=JSON.parse(line.slice(6)) as WorkspaceEvent;
        if(event.type==='turn.message'&&(event.payload.message as {messageId:string}).messageId===id&&event.payload.delta)return event;
      }else{const chunk=await reader.read();if(chunk.done)throw new Error('SSE closed');buffer+=decoder.decode(chunk.value,{stream:true});}
    }
  }
  for(const language of ['zh','en'])for(let index=0;index<20;index++){
    const id=`${language}-${index}`,text=language==='zh'?'我先检查代码。':'I will inspect the code.';
    const started=performance.now();
    input.onEvent!({type:'message.started',messageId:id,kind:'commentary'});
    input.onEvent!({type:'message.delta',messageId:id,text});
    const event=await nextDelta(id);
    if(event.payload.delta!==text)throw new Error('Text mismatch');
    result.samples.push({language,latencyMs:Number((performance.now()-started).toFixed(2))});
    input.onEvent!({type:'message.completed',messageId:id,kind:'commentary'});
  }
  const sorted=result.samples.map(value=>value.latencyMs).sort((a,b)=>a-b);
  result.p95Ms=sorted[Math.ceil(sorted.length*.95)-1];
  result.passed=result.p95Ms<=result.targetMs;
  finish({text:'Done',finalText:'Done',stopReason:'completed'});
  await mkdir('docs/evidence',{recursive:true});
  await writeFile('docs/evidence/live-stream-latency.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({samples:result.samples.length,p95Ms:result.p95Ms,targetMs:result.targetMs,passed:result.passed}));
  if(!result.passed)process.exitCode=1;
} finally {
  abort.abort();finish({text:'',stopReason:'cancelled'});await api.close();await chat.close();store.close();await rm(home,{recursive:true,force:true});
}
