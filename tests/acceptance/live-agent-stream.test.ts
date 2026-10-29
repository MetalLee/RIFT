import { RiftHostService } from '../../src/api/host-service.js';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatPage } from '../../src/chat/contracts.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { RiftStore } from '../../src/storage/database.js';
import { ChatService } from '../../src/chat/service.js';
import { startLocalApi } from '../../src/api/local-api.js';
import { readWorkspaceEvents, type WorkspaceEvent } from '../../src/events/workspace-events.js';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';
import { registerCredentialRedaction } from '../../src/api/security.js';
import { buildChatTimeline } from '../../ui/src/chat-timeline.js';
import { seedWorkspace } from './fixtures.js';

const deferred = <T>() => { let resolve!:(value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve}; };
const until = async (check:()=>boolean) => { for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Condition did not settle'); };
class Events {
  private buffer='';
  private decoder=new TextDecoder();
  readonly seen:WorkspaceEvent[]=[];
  constructor(private reader:ReadableStreamDefaultReader<Uint8Array>) {}
  async next(predicate:(event:WorkspaceEvent)=>boolean):Promise<WorkspaceEvent> {
    for (;;) {
      const boundary=this.buffer.indexOf('\n\n');
      if(boundary>=0) {
        const frame=this.buffer.slice(0,boundary);this.buffer=this.buffer.slice(boundary+2);
        const data=frame.split('\n').find(line=>line.startsWith('data: '));
        if(!frame.includes('event: workspace')||!data)continue;
        const event=JSON.parse(data.slice(6)) as WorkspaceEvent;
        expect(Number(frame.match(/^id: (\d+)/m)![1])).toBe(event.seq);
        this.seen.push(event);
        if(predicate(event))return event;
        continue;
      }
      const chunk=await this.reader.read();
      if(chunk.done)throw new Error('SSE closed before expected event');
      this.buffer+=this.decoder.decode(chunk.value,{stream:true});
    }
  }
}

describe('runtime → durable stream → authenticated HTTP SSE → chat timeline',()=>{
  it.each([
    {surface:'management',commentary:'我先检查仓库，再验证输出。',answer:'验证完成，中英文都能及时输出。'},
    {surface:'browser',commentary:'I will inspect the repository and verify streaming.',answer:'Verified: messages and tool progress stream correctly.'},
  ])('$surface streams commentary, text and tool progress before final completion',async({surface,commentary,answer})=>{
    const home=await mkdtemp(path.join(tmpdir(),'rift-live-stream-'));
    const store=new RiftStore();const {workspace}=seedWorkspace(store,'stream-workspace');
    const model=deferred<RuntimeTurnResult>(),tool=deferred<unknown>(),cleanup=deferred<void>();
    let input:RuntimeTurnInput|undefined;
    const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'controlled'}),validateConnection(){},
      runtime:()=>({async start(value){input=value;return{result:model.promise,dispose:()=>cleanup.promise};}}),
      tools:()=>[{name:'inspect_repository',description:'Inspect',inputSchema:{},execute:()=>tool.promise}]});
    const api=await startLocalApi({handle:async()=>({}),handleBrowser:async()=>({}),browserEvents:(id,after)=>readWorkspaceEvents(store,id,after)},{home,port:0});
    const origin=`http://127.0.0.1:${api.port}`;
    const abort=new AbortController();let reconnect:AbortController|undefined;
    try {
      const conversation=chat.createConversation(workspace.id,'Streaming acceptance');
      const turn=chat.send(workspace.id,conversation.id,{clientMessageId:'stream-test',content:'Please inspect'}).turn;
      await until(()=>!!input);
      const after=chat.page(workspace.id,conversation.id).snapshotCursor;
      let headers:Record<string,string>,route:string;
      if(surface==='browser') {
        const connected=await fetch(`${origin}/ui-api/v1/session/connect`,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:'{}'});
        expect(connected.status).toBe(200);
        headers={Cookie:connected.headers.get('set-cookie')!.split(';')[0]!,'Sec-Fetch-Site':'same-origin'};
        route=`/ui-api/v1/workspaces/${workspace.id}/events`;
      } else {
        headers={Authorization:`Bearer ${(await readFile(path.join(home,'management.token'),'utf8')).trim()}`};
        route=`/v1/workspaces/${workspace.id}/events`;
        expect((await fetch(origin+route)).status).toBe(401);
      }
      const response=await fetch(`${origin}${route}?after=${after}`,{headers,signal:abort.signal});
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const events=new Events(response.body!.getReader());
      const emit=input!.onEvent!;
      const reasoning=surface==='browser'?'Checking the inputs.':'正在核对输入。';
      emit({type:'message.started',messageId:'thinking',kind:'reasoning'});
      emit({type:'message.delta',messageId:'thinking',text:reasoning});

      expect(chat.turn(workspace.id,turn.id).status).toBe('running');
      emit({type:'message.completed',messageId:'thinking',kind:'reasoning'});
      expect(chat.turn(workspace.id,turn.id).streamMessages?.some(message=>message.kind==='reasoning')).toBeFalsy();
      const sentAt=performance.now();
      emit({type:'message.started',messageId:'progress',kind:'commentary'});
      emit({type:'message.delta',messageId:'progress',text:commentary.slice(0,5)});
      const first=await events.next(event=>event.type==='turn.message'&&event.payload.delta===commentary.slice(0,5));
      expect(performance.now()-sentAt).toBeLessThan(1000);
      expect(chat.turn(workspace.id,turn.id).status).toBe('running');
      expect(chat.page(workspace.id,conversation.id).messages.filter(message=>message.role==='assistant')).toHaveLength(0);
      emit({type:'message.delta',messageId:'progress',text:commentary.slice(5)});
      emit({type:'message.completed',messageId:'progress',kind:'commentary'});
      await events.next(event=>event.type==='turn.message'&&(event.payload.message as {status:string}).status==='completed');
      const pending=input!.tools[0]!.execute({},input!.signal);
      const started=await events.next(event=>event.type==='turn.activity'&&(event.payload.activity as {type:string}).type==='tool.started');
      expect(started.payload.activity).toMatchObject({toolName:'inspect_repository',phase:'tool'});
      tool.resolve({files:3});await pending;
      await events.next(event=>event.type==='turn.activity'&&(event.payload.activity as {type:string}).type==='tool.completed');
      // Runtime-only tools follow the same API path.
      emit({type:'tool.started',toolCallId:'shell-1',toolName:'exec_command'});
      await events.next(event=>event.type==='turn.activity'&&(event.payload.activity as {toolName:string}).toolName==='exec_command');
      emit({type:'tool.completed',toolCallId:'shell-1',toolName:'exec_command'});
      const secret='stream-api-secret-987654321';registerCredentialRedaction('STREAM_API_TEST',secret);
      emit({type:'message.started',messageId:'answer',kind:'final'});
      emit({type:'message.delta',messageId:'answer',text:answer.slice(0,5)});
      await events.next(event=>event.type==='turn.message'&&(event.payload.message as {messageId:string}).messageId==='answer');
      emit({type:'message.delta',messageId:'answer',text:answer.slice(5)+` api_key="${secret.slice(0,10)}`});
      emit({type:'message.delta',messageId:'answer',text:secret.slice(10)+'"'});
      emit({type:'message.completed',messageId:'answer',kind:'final'});
      const settled=await events.next(event=>event.type==='turn.message'&&(event.payload.message as {messageId:string;status:string}).messageId==='answer'&&(event.payload.message as {status:string}).status==='completed');
      expect(JSON.stringify(events.seen)).not.toContain(secret);
      const page=chat.page(workspace.id,conversation.id);
      expect(page.turns[0]!.streamMessages?.map(message=>message.kind)).toEqual(['commentary','final']);
      expect(buildChatTimeline(page.messages,page.turns,page.chunks).items[0]!.drafts.map(message=>message.text)[0]).toBe(commentary);
      expect(page.turns[0]!.firstModelEventAt).toBeTruthy();expect(page.turns[0]!.firstVisibleTextAt).toBeTruthy();
      // Resume from Last-Event-ID: only later events are replayed, with no rerun.
      reconnect=new AbortController();
      const replay=await fetch(origin+route,{headers:{...headers,'Last-Event-ID':String(first.seq)},signal:reconnect.signal});
      const resumed=new Events(replay.body!.getReader());
      await resumed.next(event=>event.seq===settled.seq);
      expect(resumed.seen.every(event=>event.seq>first.seq)).toBe(true);
      model.resolve({text:commentary+'\n'+answer,finalText:answer,stopReason:'completed'});
      await until(()=>chat.turn(workspace.id,turn.id).phase==='cleanup');
      expect(chat.page(workspace.id,conversation.id).turns[0]!.streamMessages?.at(-1)?.status).toBe('completed');
      cleanup.resolve();await until(()=>chat.turn(workspace.id,turn.id).status==='completed');
      const finalPage=chat.page(workspace.id,conversation.id);
      expect(finalPage.messages.filter(message=>message.role==='assistant').map(message=>message.content)).toEqual([answer]);
      expect(buildChatTimeline(finalPage.messages,finalPage.turns,finalPage.chunks).items.flatMap(item=>item.drafts).map(message=>message.text)).toEqual([commentary]);
    } finally {
      abort.abort();reconnect?.abort();tool.resolve({});model.resolve({text:'',stopReason:'cancelled'});cleanup.resolve();
      await api.close();await chat.close();store.close();await rm(home,{recursive:true,force:true});
    }
  });
});


it('offers management-token snapshots for gap recovery with workspace isolation and pagination',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'rift-stream-snapshot-'));
  const host=new RiftHostService({subagents:{list:()=>[]},llm:{listProviders:()=>[]}} as unknown as Context,{home,port:0,leadProvider:'unused',leadModel:'unused',checks:[]});
  const first=seedWorkspace(host.store,'snapshot-a'),second=seedWorkspace(host.store,'snapshot-b');
  const conversation=host.chat.createConversation(first.workspace.id,'Snapshot');
  for(let i=0;i<3;i++)host.store.exec("INSERT INTO messages(id,workspace_id,conversation_id,recipient_agent_id,role,content,status,created_at) VALUES(?,?,?,?,'user',?,'completed',?)",`snapshot-${i}`,first.workspace.id,conversation.id,first.roles[0]!.id,`Message ${i}`,new Date().toISOString());
  const api=await startLocalApi(host,{home:path.join(home,'http'),port:0,uiEnabled:false});
  try{
    const token=(await readFile(path.join(home,'http','management.token'),'utf8')).trim();
    const url=`http://127.0.0.1:${api.port}/v1/workspaces/${first.workspace.id}/conversations/${conversation.id}/messages?limit=1`;
    expect((await fetch(url)).status).toBe(401);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    expect(response.status).toBe(200);
    const snapshot=await response.json() as ChatPage;
    expect(snapshot.messages).toHaveLength(1);expect(snapshot.nextBefore).toBeTruthy();expect(snapshot.snapshotCursor).toBeGreaterThan(0);
    const foreign=await fetch(url.replace(first.workspace.id,second.workspace.id),{headers:{Authorization:`Bearer ${token}`}});
    expect(foreign.status).toBe(404);
  }finally{await api.close();await host.close();await rm(home,{recursive:true,force:true});}
});


it('preserves interrupted structured output and rejects late runtime callbacks after cancellation',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'rift-stream-cancel-'));
  const store=new RiftStore(),{workspace}=seedWorkspace(store,'cancel-stream');
  const model=deferred<RuntimeTurnResult>();let input:RuntimeTurnInput|undefined;
  const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'controlled'}),validateConnection(){},tools:()=>[],runtime:()=>({async start(value){input=value;return{result:model.promise,dispose:async()=>{}};}})});
  try{
    const conversation=chat.createConversation(workspace.id,'Cancellation');
    const turn=chat.send(workspace.id,conversation.id,{clientMessageId:'cancel',content:'Inspect'}).turn;
    await until(()=>!!input);
    input!.onEvent!({type:'message.started',messageId:'partial',kind:'commentary'});
    input!.onEvent!({type:'message.delta',messageId:'partial',text:'我正在检查代码。'});
    chat.stop(workspace.id,turn.id);
    await until(()=>chat.turn(workspace.id,turn.id).status==='cancelled');
    const stopped=chat.turn(workspace.id,turn.id);
    expect(stopped.streamMessages?.[0]).toMatchObject({text:'我正在检查代码。',status:'interrupted'});
    expect(stopped.cleanupStatus).toBe('confirmed');
    input!.onEvent!({type:'message.delta',messageId:'partial',text:'late content'});
    expect(chat.turn(workspace.id,turn.id).streamMessages).toEqual(stopped.streamMessages);
    const page=chat.page(workspace.id,conversation.id);
    expect(buildChatTimeline(page.messages,page.turns,page.chunks).items[0]!.drafts[0]?.status).toBe('interrupted');
  }finally{model.resolve({text:'',stopReason:'cancelled'});await chat.close();store.close();await rm(home,{recursive:true,force:true});}
});
