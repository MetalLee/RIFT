import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiftStore } from '../../src/storage/database.js';
import { schedulerLimits, schedulingOrder, validateDag } from '../../src/task/scheduler.js';

describe('E1 durable scheduler migration and policy',()=>{
  it('migrates a v2 ledger without losing runs, references or retained cleanup and reopens multiple workflows',()=>{
    const directory=mkdtempSync(join(tmpdir(),'rift-migration-')),filename=join(directory,'rift.db');
    const old=new DatabaseSync(filename);
    old.exec(readFileSync(new URL('../../migrations/0001_initial.sql',import.meta.url),'utf8'));
    old.exec(readFileSync(new URL('../../migrations/0002_result_artifact.sql',import.meta.url),'utf8'));
    old.exec(`INSERT INTO workspaces VALUES('w','workspace','repo','active');
      INSERT INTO repositories VALUES('repo','w','repo','repo/.git','main');
      INSERT INTO provider_bindings VALUES('p','codex','test',1,'{}','[]');
      INSERT INTO roles VALUES('dev','w','developer-a','subagent','p','old prompt',1);
      INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('wf','w','goal','running','refs/heads/rift/old','abc');
      INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES('t','wf','dev','analysis','old','old','[]','[]','blocked');
      INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,cleanup_status,deadline,created_at) VALUES('r','t','dev','develop',1,'interrupted','{"role":{"prompt":"snapshot"}}','unknown','later','earlier');`);
    old.close();
    try{
      const store=new RiftStore(filename);
      try{
        expect(store.role('dev')).toMatchObject({purpose:'developer',enabled:1,prompt:'old prompt'});
        expect(store.run('r')).toMatchObject({cleanupStatus:'unknown',slotReleasedAt:null,providerSnapshot:{role:{prompt:'snapshot'}}});
        expect(store.task('t')).toMatchObject({priority:0,analysisItems:null,roleId:'dev'});
        expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        store.exec("INSERT INTO workspaces(id,name,root_path,status) VALUES('w2','workspace2','repo2','active')");
        store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('wf2','w2','goal','running','refs/heads/rift/other','abc')");
        expect(()=>store.exec("INSERT INTO tasks(id,workflow_id,role_id,kind,title,instructions,expected_paths,acceptance_criteria,status) VALUES('bad','wf2','dev','analysis','x','x','[]','[]','pending')")).toThrow(/workspace/i);
      }finally{store.close();}
      const reopened=new RiftStore(filename);
      try{expect(reopened.all('SELECT * FROM workflows')).toHaveLength(2);expect(reopened.run('r').slotReleasedAt).toBeNull();}finally{reopened.close();}
    }finally{rmSync(directory,{recursive:true});}
  });
  it('reserves review headroom and bounds all configurable quotas',()=>{
    expect(schedulerLimits({developers:8})).toMatchObject({developers:8,total:9});
    expect(()=>schedulerLimits({developers:8,total:8})).toThrow(/review/i);
    for(const input of [{developers:0},{developers:129},{maxTasks:10001},{maxReplans:-1},{agingMs:0},{total:NaN}])expect(()=>schedulerLimits(input)).toThrow();
  });
  it('uses persisted workflow turns before task priority and ages old requests above fresh high priority',()=>{
    const clock=1_000_000;
    const entries=[{id:'busy',createdAt:new Date(clock).toISOString(),priority:100,lastScheduled:2,sequence:1},{id:'new',createdAt:new Date(clock).toISOString(),priority:100,lastScheduled:0,sequence:2},{id:'aged',createdAt:new Date(clock-201_000).toISOString(),priority:-100,lastScheduled:0,sequence:3}];
    expect(schedulingOrder(entries,1000,clock).map(entry=>entry.id)).toEqual(['aged','new','busy']);
  });
  it('validates the configured maximum depth without recursive stack overflow',()=>{
    const graph=Array.from({length:10000},(_,index)=>({id:String(index),dependsOn:index?[String(index-1)]:[]}));
    expect(()=>validateDag(graph)).not.toThrow();graph[0]!.dependsOn=['9999'];expect(()=>validateDag(graph)).toThrow(/cycle/i);
  });
});
