import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { id, now, type RiftStore } from './database.js';
/** Immutable sanitized business result; native session logs remain owned by DSH. */
export function saveResultArtifact(store:RiftStore,workspaceId:string,runId:string,value:unknown,type:'result'|'input'='result'):string|null {
  if(store.filePath===':memory:')return null;
  const body=JSON.stringify(value),sha256=createHash('sha256').update(body).digest('hex');
  const artifactId=id('artifact');
  const relativePath=['workspaces',workspaceId,'runs',runId,'artifacts',`${artifactId}.json`].join('/');
  const absolutePath=join(dirname(store.filePath),...relativePath.split('/'));
  mkdirSync(dirname(absolutePath),{recursive:true});writeFileSync(absolutePath,body,{encoding:'utf8',flag:'wx'});
  store.exec('INSERT INTO artifacts(id,run_id,type,relative_path,sha256,byte_size,created_at) VALUES(?,?,?,?,?,?,?)',artifactId,runId,type,relativePath,sha256,Buffer.byteLength(body),now());
  return artifactId;
}
