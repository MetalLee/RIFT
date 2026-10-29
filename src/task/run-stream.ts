import type { SummaryTranslationFactory } from '../chat/summary-translation.js';
import type { RuntimeEvent } from '../agent/runtime-types.js';
import type { RunStreamMessage } from '../chat/contracts.js';
import { TurnStream } from '../chat/turn-stream.js';
import { now, type RiftStore } from '../storage/database.js';

/** Run output is a read-only conversation projection, never a new Lead trigger. */
export function conversationRunMessages(store:RiftStore,workspaceId:string,conversationId:string):RunStreamMessage[] {
  return store.all<RunStreamMessage>(`SELECT m.*,r.role_id,r.task_id,w.workspace_id,wc.conversation_id,
    CASE WHEN m.status='streaming' AND r.status NOT IN ('preparing','running') THEN 'interrupted' ELSE m.status END status
    FROM run_stream_messages m JOIN runs r ON r.id=m.run_id JOIN tasks t ON t.id=r.task_id
    JOIN workflows w ON w.id=t.workflow_id JOIN workflow_conversations wc ON wc.workflow_id=w.id
    WHERE w.workspace_id=? AND wc.workspace_id=? AND wc.conversation_id=? ORDER BY m.seq`,workspaceId,workspaceId,conversationId);
}

export class RunChatStream {
  private createStream?: (messageId:string)=>TurnStream;
  private streams=new Map<string,TurnStream>();
  private settled=new Set<string>();
  private closed=false;
  private kinds=new Map<string,string>();
  constructor(private store:RiftStore,private runId:string,summaryTranslation?:SummaryTranslationFactory) {
    const owner=store.get<{workspaceId:string;conversationId:string;roleId:string;taskId:string}>(`SELECT w.workspace_id,wc.conversation_id,r.role_id,r.task_id
      FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows w ON w.id=t.workflow_id
      JOIN workflow_conversations wc ON wc.workflow_id=w.id AND wc.workspace_id=w.workspace_id WHERE r.id=?`,runId);
    if(!owner)return;
    const translate=summaryTranslation?.({...owner,agentId:owner.roleId,ownerType:'run',ownerId:runId});
    this.createStream=id=>new TurnStream(store,runId,owner.workspaceId,owner.conversationId,()=>this.finishMessage(id,true),(messageId,message)=>{
      const prior=store.get<RunStreamMessage>('SELECT * FROM run_stream_messages WHERE run_id=? AND message_id=?',runId,messageId);
      if(prior&&prior.kind===message.kind&&prior.text===message.text&&prior.status===message.status)return;
      const timestamp=now();
      store.exec(`INSERT INTO run_stream_messages(run_id,message_id,kind,text,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(run_id,message_id) DO UPDATE SET kind=excluded.kind,text=excluded.text,status=excluded.status,updated_at=excluded.updated_at,version=run_stream_messages.version+1`,runId,messageId,message.kind,message.text,message.status,timestamp,timestamp);
      const row=store.require<RunStreamMessage>('SELECT * FROM run_stream_messages WHERE run_id=? AND message_id=?',runId,messageId);
      const append=row.text.startsWith(prior?.text??''),offset=append?(prior?.text.length??0):0;
      store.exec("INSERT INTO workspace_events(workspace_id,type,entity_id,payload,occurred_at) VALUES(?,'run.message',?,?,?)",owner.workspaceId,runId,
        JSON.stringify({conversationId:owner.conversationId,message:{...row,...owner,text:undefined},offset,delta:append?row.text.slice(offset):row.text,replace:!append}),timestamp);
    },translate);
  }
  accept(event:RuntimeEvent):void {
    if(this.closed||!this.createStream||!('messageId' in event)||this.settled.has(event.messageId))return;
    if(event.type==='message.started')this.kinds.set(event.messageId,event.kind);
    const kind=('kind' in event?event.kind:undefined)??this.kinds.get(event.messageId);
    // Reasoning is not public narration. Unknown deltas are never guessed public.
    if(!kind||kind==='reasoning')return;
    if(!this.store.get("SELECT id FROM runs WHERE id=? AND status IN ('preparing','running') AND slot_released_at IS NULL",this.runId))return;
    let stream=this.streams.get(event.messageId);
    if(!stream){stream=this.createStream(event.messageId);this.streams.set(event.messageId,stream);}
    try{stream.accept(event);if(event.type==='message.completed')this.finishMessage(event.messageId,!!event.interrupted);}catch{this.finishMessage(event.messageId,true);}
  }
  private finishMessage(messageId:string,interrupted:boolean):void {
    const stream=this.streams.get(messageId);this.streams.delete(messageId);this.settled.add(messageId);this.kinds.delete(messageId);
    try{stream?.finish(interrupted);}catch{/* Output observability must not change task acceptance or cleanup. */}
  }
  finish(interrupted:boolean):void {
    if(this.closed)return;this.closed=true;
    for(const id of this.streams.keys())this.finishMessage(id,interrupted);
    this.kinds.clear();
  }
}
