import { describe,expect,it } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RiftStore } from '../../src/storage/database.js';
import { seedWorkspace } from '../acceptance/fixtures.js';
import { ChatService } from '../../src/chat/service.js';
import { RiftError } from '../../src/contracts/index.js';
import type { ChatConnection } from '../../src/chat/contracts.js';
const until=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out');};
describe('validated member discussion fallback',()=>{
  it('persists a failed runtime diagnostic separately from assistant text and redacts secrets',async()=>{
    const store=new RiftStore(),{workspace}=seedWorkspace(store),home=await mkdtemp(path.join(tmpdir(),'rift-turn-diagnostic-'));
    const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'test'}),validateConnection(){},tools:()=>[],runtime:()=>({async start(){return{result:Promise.resolve({text:'',stopReason:'failed',diagnostic:'MISSING_CREDENTIAL token=private-value'}),async dispose(){}};}})});
    try{
      const conversation=chat.createConversation(workspace.id,'Diagnostic test');
      const {turn}=chat.send(workspace.id,conversation.id,{clientMessageId:'failure',content:'Hello'});
      await until(()=>chat.turn(workspace.id,turn.id).status==='failed');
      const settled=chat.turn(workspace.id,turn.id);expect(settled.error).toContain('MISSING_CREDENTIAL');expect(settled.error).not.toContain('private-value');expect(settled.cleanupStatus).toBe('confirmed');
    }finally{await chat.close();store.close();if(path.dirname(home)!==path.resolve(tmpdir())||!path.basename(home).startsWith('rift-turn-diagnostic-'))throw new Error('Unsafe cleanup');await rm(home,{recursive:true,force:true});}
  });
  it('uses the execution binding only when discussion is unset, validates it and keeps explicit configuration authoritative',async()=>{
    const store=new RiftStore(),{workspace,roles}=seedWorkspace(store),home=await mkdtemp(path.join(tmpdir(),'rift-member-fallback-'));
    const member=roles.find(role=>role.purpose==='developer')!,validated:ChatConnection[]=[];
    store.exec("UPDATE provider_bindings SET runtime='codex',model='verified-model',reasoning_effort='high' WHERE id=?",member.providerBindingId);
    const chat=new ChatService({store,home,defaultConnection:()=>({runtime:'codex',model:'verified-model'}),validateConnection(connection){validated.push(connection);if(connection.model==='unverified')throw new RiftError('MODEL_UNVERIFIED','Model is not verified.');},tools:()=>[],runtime:()=>({async start(){return{result:Promise.resolve({text:'Discussion answered.',stopReason:'completed'}),async dispose(){}};}})});
    try{
      const conversation=chat.createConversation(workspace.id,'Configured execution');
      const sent=chat.send(workspace.id,conversation.id,{clientMessageId:'member-fallback',recipientAgentId:member.id,content:'Discuss this task.'});
      await until(()=>chat.turn(workspace.id,sent.turn.id).status==='completed');
      expect(sent.turn.configuration.connection).toEqual({runtime:'codex',model:'verified-model',reasoningEffort:'high'});expect(validated.length).toBeGreaterThan(0);
      store.exec('UPDATE roles SET chat_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'explicit-model'}),member.id);
      expect(chat.validateAgentConnection(workspace.id,member.id).model).toBe('explicit-model');
      store.exec('UPDATE roles SET chat_connection=? WHERE id=?',JSON.stringify({runtime:'codex',model:'unverified'}),member.id);
      expect(()=>chat.validateAgentConnection(workspace.id,member.id)).toThrowError(/not verified/);
      store.exec('UPDATE roles SET chat_connection=NULL WHERE id=?',member.id);store.exec("UPDATE provider_bindings SET runtime='claude' WHERE id=?",member.providerBindingId);
      expect(()=>chat.validateAgentConnection(workspace.id,member.id)).toThrowError(/supported execution connection/);
    }finally{await chat.close();store.close();await rm(home,{recursive:true,force:true});}
  });
  it('projects real lifecycle transitions without producing turn.updated for body progress or diagnostic phase changes',async()=>{
    const store=new RiftStore(),{workspace}=seedWorkspace(store),home=await mkdtemp(path.join(tmpdir(),'rift-turn-projection-'));
    const chat=new ChatService({store,home,canStart:()=>false,defaultConnection:()=>({runtime:'codex',model:'test'}),validateConnection(){},tools:()=>[],runtime:()=>({async start(){throw Error('Must remain queued');}})});
    try{
      const conversation=chat.createConversation(workspace.id),turn=chat.send(workspace.id,conversation.id,{clientMessageId:'projection',content:'Hello'}).turn;
      expect(store.require<{visibility:string}>("SELECT visibility FROM messages WHERE kind='conversation_title'").visibility).toBe('internal');
      const count=()=>store.require<{count:number}>("SELECT count(*) AS count FROM workspace_events WHERE type='turn.updated' AND entity_id=?",turn.id).count;
      const before=count();store.exec("UPDATE agent_turns SET phase='generating',last_progress_at='now',version=version+1 WHERE id=?",turn.id);expect(count()).toBe(before);
      store.exec("UPDATE agent_turns SET status='running',version=version+1 WHERE id=?",turn.id);expect(count()).toBe(before+1);
      store.exec("UPDATE agent_turns SET status='running',version=version+1 WHERE id=?",turn.id);expect(count()).toBe(before+1);
      store.exec("UPDATE agent_turns SET cleanup_status='confirmed',version=version+1 WHERE id=?",turn.id);expect(count()).toBe(before+2);
    }finally{await chat.close();store.close();await rm(home,{recursive:true,force:true});}
  });
});
