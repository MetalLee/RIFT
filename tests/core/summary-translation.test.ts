import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicSummaryBuffer, SummaryTranslator } from '../../src/chat/summary-translation.js';
import type { RuntimeTurnInput, RuntimeTurnResult } from '../../src/agent/runtime-types.js';
const homes:string[]=[];
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
afterEach(async()=>{await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
describe('public summary translation',()=>{
 it('buffers full source, publishes only a complete translation, and leaves final output independent',async()=>{
  let resolve!:(text:string)=>void;
  const translate=vi.fn(()=>new Promise<string>(r=>{resolve=r;})),publish=vi.fn();
  const stream=new PublicSummaryBuffer(translate,publish);
  stream.accept({type:'message.started',messageId:'s',kind:'reasoning_summary'});
  stream.accept({type:'message.delta',messageId:'s',text:'First paragraph.\n\n'});
  stream.accept({type:'message.delta',messageId:'s',text:'Second paragraph.'});
  expect(translate).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
  stream.accept({type:'message.completed',messageId:'s'});stream.finish(false);
  expect(stream.accept({type:'message.completed',messageId:'answer',kind:'final',text:'最终回复'})).toBe(false);
  await tick();expect(translate).toHaveBeenCalledWith('First paragraph.\n\nSecond paragraph.');
  expect(publish).not.toHaveBeenCalled();resolve('第一段。\n\n第二段。');await tick();
  expect(publish).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^translated-summary:/),'第一段。\n\n第二段。');
  stream.accept({type:'message.completed',messageId:'s',text:'duplicated'});await tick();
  expect(translate).toHaveBeenCalledTimes(1);
 });
 it('does not translate private reasoning, incomplete or interrupted summaries, or display source after failure',async()=>{
  const translate=vi.fn(async()=>{throw new Error('translation offline');}),publish=vi.fn();
  const stream=new PublicSummaryBuffer(translate,publish);
  stream.accept({type:'message.started',messageId:'private',kind:'reasoning'});
  stream.accept({type:'message.completed',messageId:'private',text:'SECRET'});
  stream.accept({type:'message.completed',messageId:'interrupted',kind:'reasoning_summary',text:'partial',interrupted:true});
  stream.accept({type:'message.started',messageId:'incomplete',kind:'reasoning_summary'});
  stream.accept({type:'message.delta',messageId:'incomplete',text:'partial'});
  stream.accept({type:'message.completed',messageId:'public',kind:'reasoning_summary',text:'English source'});
  stream.finish(false);await tick();
  expect(translate).toHaveBeenCalledTimes(1);expect(publish).not.toHaveBeenCalled();
 });
 it('discards completed translation when its source is cancelled',async()=>{
  let resolve!:(text:string)=>void;const publish=vi.fn();
  const stream=new PublicSummaryBuffer(()=>new Promise(r=>{resolve=r;}),publish);
  stream.accept({type:'message.completed',messageId:'s',kind:'reasoning_summary',text:'source'});
  await tick();stream.finish(true);resolve('译文');await tick();expect(publish).not.toHaveBeenCalled();
 });
 it('uses each agent discussion connection, no tools/session, bounded parallelism and full finalText only',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'rift-summary-test-'));homes.push(home);
  const inputs:RuntimeTurnInput[]=[],finish:Array<(value:RuntimeTurnResult)=>void>=[];
  const translator=new SummaryTranslator({home,concurrency:1,valid:()=>true,
    context:owner=>({connection:{runtime:'dsh',provider:owner.agentId,model:owner.agentId+'-chat'},languageSamples:['请使用简体中文','继续']}),
    runtime:()=>({start:async input=>{inputs.push(input);return{result:new Promise(r=>finish.push(r)),dispose:async()=>{}};}})});
  const owner={workspaceId:'w',conversationId:'c',ownerType:'run' as const,ownerId:'r'};
  const a=translator.forOwner({...owner,agentId:'a'})('English A'),b=translator.forOwner({...owner,agentId:'b'})('English B');
  await vi.waitFor(()=>expect(inputs).toHaveLength(1));
  expect(inputs[0]).toMatchObject({model:'a-chat',tools:[]});expect(inputs[0]!.session).toBeUndefined();
  expect(inputs[0]!.repositoryAccess).toBeUndefined();expect(inputs[0]!.onEvent).toBeUndefined();
  expect(inputs[0]!.messages[0]!.content).toContain('请使用简体中文');
  finish[0]!({text:'partial commentary',finalText:'完整译文 A',stopReason:'completed'});
  expect(await a).toBe('完整译文 A');
  await vi.waitFor(()=>expect(inputs).toHaveLength(2));expect(inputs[1]!.model).toBe('b-chat');
  finish[1]!({text:'完整译文 B',stopReason:'completed'});expect(await b).toBe('完整译文 B');translator.close();
 });
 it('times out a hung translator and suppresses queued work on shutdown',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'rift-summary-test-'));homes.push(home);
  const dispose=vi.fn(async()=>{}),start=vi.fn(async()=>({result:new Promise<RuntimeTurnResult>(()=>{}),dispose}));
  const translator=new SummaryTranslator({home,concurrency:1,timeoutMs:40,valid:()=>true,context:()=>({connection:{runtime:'dsh',provider:'p',model:'chat'},languageSamples:['中文']}),runtime:()=>({start})});
  const translate=translator.forOwner({workspaceId:'w',agentId:'a',conversationId:'c',ownerType:'turn',ownerId:'t'});
  expect(await translate('source')).toBeUndefined();expect(dispose).toHaveBeenCalledTimes(1);
  const pending=translate('next'),queued=translate('last');translator.close();
  expect(await pending).toBeUndefined();expect(await queued).toBeUndefined();
 });
});

it('persists a late translated Turn summary without exposing source or delaying final output',async()=>{
 const {RiftStore}=await import('../../src/storage/database.js');
 const {seedWorkspace}=await import('../acceptance/fixtures.js');
 const {TurnStream}=await import('../../src/chat/turn-stream.js');
 const store=new RiftStore(),{workspace,roles}=seedWorkspace(store);
 store.exec("INSERT INTO conversations(id,workspace_id,title,created_at) VALUES('c',?,'Test','now')",workspace.id);
 store.exec("INSERT INTO messages(id,workspace_id,conversation_id,role,content,status,created_at) VALUES('input',?,'c','user','请分析','completed','now')",workspace.id);
 store.exec("INSERT INTO agent_turns(id,workspace_id,conversation_id,message_id,agent_id,status,configuration,created_at) VALUES('t',?,'c','input',?,'running','{}','now')",workspace.id,roles[0]!.id);
 let resolve!:(text:string)=>void;
 const stream=new TurnStream(store,'t',workspace.id,'c',()=>{},undefined,()=>new Promise(r=>{resolve=r;}));
 try{
  stream.accept({type:'message.started',messageId:'s',kind:'reasoning_summary'});
  stream.accept({type:'message.delta',messageId:'s',text:'Original English paragraph'});
  stream.flush();expect(store.all('SELECT * FROM turn_stream_messages')).toEqual([]);
  stream.accept({type:'message.completed',messageId:'s'});
  stream.accept({type:'message.completed',messageId:'final',kind:'final',text:'最终答复'});
  stream.finish(false);store.exec("UPDATE agent_turns SET status='completed' WHERE id='t'");
  expect(store.all<{text:string}>('SELECT text FROM turn_stream_messages').map(m=>m.text)).toEqual(['最终答复']);
  await tick();resolve('完整中文段落');await tick();
  expect(store.all<{text:string}>('SELECT text FROM turn_stream_messages ORDER BY seq').map(m=>m.text)).toEqual(['最终答复','完整中文段落']);
  expect(JSON.stringify(store.all('SELECT * FROM workspace_events'))).not.toContain('Original English');
 }finally{store.close();}
});
