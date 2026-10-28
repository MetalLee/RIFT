import {describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RiftStore} from '../../src/storage/database.js';
import {ChatService} from '../../src/chat/service.js';
import {seedWorkspace} from '../acceptance/fixtures.js';
import type {RuntimeHandle} from '../../src/agent/runtime-types.js';

async function fixture(dispose:RuntimeHandle['dispose']=async()=>{}) {
  const store=new RiftStore(),{workspace}=seedWorkspace(store),home=await mkdtemp(path.join(tmpdir(),'rift-stop-'));
  let enabled=false;
  const settled=vi.fn();
  const chat=new ChatService({store,home,canStart:()=>enabled,defaultConnection:()=>({runtime:'codex',model:'test'}),validateConnection(){},tools:()=>[],onTurnSettled:settled,
    runtime:()=>({async start(){return {result:Promise.resolve({text:'reply',stopReason:'completed' as const}),dispose};}})});
  const conversation=chat.createConversation(workspace.id,'Stop recovery');
  const turn=chat.send(workspace.id,conversation.id,{clientMessageId:'stop-test',content:'hello'}).turn;
  return {store,chat,turn,settled,start(){enabled=true;chat.pump();},async close(){await chat.close();store.close();await rm(home,{recursive:true,force:true});}};
}
const until=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Turn did not settle');};
function orphan(f:Awaited<ReturnType<typeof fixture>>,receipt:boolean){
  f.store.exec("UPDATE agent_turns SET status='stopping',phase='cleanup' WHERE id=?",f.turn.id);
  f.store.exec("INSERT INTO execution_leases(id,owner_type,owner_id,workspace_id,agent_id,capacity,acquired_at) VALUES(?,'turn',?,?,?,'lead',?)",`lease-${f.turn.id}`,f.turn.id,f.turn.workspaceId,f.turn.agentId,new Date().toISOString());
  if(receipt)(f.chat as unknown as {cleanupReceipts:Set<string>}).cleanupReceipts.add(f.turn.id);
}
describe('discussion stop recovery',()=>{
  it.each([true,false])('stops an orphan turn and releases only with cleanup receipt=%s',async receipt=>{
    const f=await fixture();try{orphan(f,receipt);const result=f.chat.stop(f.turn.workspaceId,f.turn.id);
      expect(result.status).toBe('cancelled');expect(result.cleanupStatus).toBe(receipt?'confirmed':'unknown');
      const lease=f.store.require<{releasedAt:string|null}>('SELECT released_at FROM execution_leases WHERE owner_id=?',f.turn.id);
      expect(lease.releasedAt!==null).toBe(receipt);expect(f.settled).toHaveBeenCalledOnce();
      f.chat.stop(f.turn.workspaceId,f.turn.id);expect(f.settled).toHaveBeenCalledOnce();
    }finally{await f.close();}
  });
  it('settles a final-message persistence failure instead of silently losing the active handle',async()=>{
    const f=await fixture();try{
      f.store.db.exec("CREATE TRIGGER reject_test_reply BEFORE INSERT ON messages WHEN NEW.sender_type='agent' BEGIN SELECT RAISE(ABORT,'injected reply failure'); END");
      f.start();await until(()=>f.chat.turn(f.turn.workspaceId,f.turn.id).endedAt!==null);
      const turn=f.chat.turn(f.turn.workspaceId,f.turn.id);expect(turn.status).toBe('failed');expect(turn.cleanupStatus).toBe('confirmed');expect(turn.error).toContain('injected reply failure');
      expect(f.store.require<{releasedAt:string|null}>('SELECT released_at FROM execution_leases WHERE owner_id=?',f.turn.id).releasedAt).not.toBeNull();
      expect(f.settled).toHaveBeenCalledOnce();
    }finally{await f.close();}
  });
  it('settles synchronous disposal errors and retains the unconfirmed lease',async()=>{
    const f=await fixture(()=>{throw Error('dispose failed synchronously');});try{
      f.start();await until(()=>f.chat.turn(f.turn.workspaceId,f.turn.id).endedAt!==null);
      const turn=f.chat.turn(f.turn.workspaceId,f.turn.id);expect(turn.cleanupStatus).toBe('unknown');expect(turn.error).toContain('dispose failed synchronously');
      expect(f.store.require<{releasedAt:string|null}>('SELECT released_at FROM execution_leases WHERE owner_id=?',f.turn.id).releasedAt).toBeNull();
    }finally{await f.close();}
  });
  it('honors a stop received while disposal is pending',async()=>{
    let finish!:()=>void;const disposed=new Promise<void>(r=>{finish=r;});const f=await fixture(()=>disposed);
    try{f.start();await until(()=>f.chat.turn(f.turn.workspaceId,f.turn.id).phase==='cleanup');f.chat.stop(f.turn.workspaceId,f.turn.id);finish();
      await until(()=>f.chat.turn(f.turn.workspaceId,f.turn.id).endedAt!==null);expect(f.chat.turn(f.turn.workspaceId,f.turn.id).status).toBe('cancelled');
    }finally{finish();await f.close();}
  });
});
