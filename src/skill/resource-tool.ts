import {z} from 'zod';
import type {RiftStore} from '../storage/database.js';
import type {RuntimeTool} from '../agent/runtime-types.js';
import type {CompiledSkills} from './service.js';
import {invariant} from '../contracts/index.js';
import {redact} from '../api/security.js';
const input=z.object({versionId:z.string().min(1),path:z.string().min(1),offset:z.number().int().min(0).default(0),maxBytes:z.number().int().min(1).max(65536).default(65536)}).strict();
/** Reads captured bytes, not mutable files or a currently reassigned Skill. This
 * tool is also usable by formal read-only review/analysis without a shell. */
export function skillResourceTool(store:RiftStore,ownerType:'turn'|'run',ownerId:string,assertLive:()=>void):RuntimeTool {
 return {name:'rift_skill_resource',description:'Read an assigned Skill resource from this execution immutable snapshot. versionId and relative path select a captured resource, not an arbitrary filesystem path. Use offset/maxBytes for large text. Available in read-only review/analysis; never executes scripts.',inputSchema:z.toJSONSchema(input,{io:'input'}),execute:async(raw,signal)=>{
  signal.throwIfAborted();assertLive();const args=input.parse(raw);
  const row=store.get<{snapshotJson:string}>('SELECT snapshot_json FROM skill_execution_snapshots WHERE owner_type=? AND owner_id=?',ownerType,ownerId);
  invariant(row,'NOT_FOUND','This execution has no Skill snapshot.');const snapshot=JSON.parse(row.snapshotJson) as CompiledSkills;
  const resource=snapshot.resources.find(r=>r.versionId===args.versionId&&r.path===args.path);
  invariant(resource,'NOT_FOUND','Resource is not in this execution Skill snapshot.');
  const bytes=Buffer.from(resource.contentBase64,'base64'),slice=bytes.subarray(args.offset,args.offset+args.maxBytes);
  return {versionId:args.versionId,path:args.path,content:redact(slice.toString('utf8'),65536),sha256:resource.sha256,offset:args.offset,nextOffset:args.offset+slice.length,totalBytes:bytes.length,truncated:args.offset+slice.length<bytes.length};
 }};
}
export function skillResourceTools(store:RiftStore,ownerType:'turn'|'run',ownerId:string,assertLive:()=>void):RuntimeTool[] {
 const row=store.get<{snapshotJson:string}>('SELECT snapshot_json FROM skill_execution_snapshots WHERE owner_type=? AND owner_id=?',ownerType,ownerId);
 return row&&(JSON.parse(row.snapshotJson) as CompiledSkills).resources.length?[skillResourceTool(store,ownerType,ownerId,assertLive)]:[];
}
