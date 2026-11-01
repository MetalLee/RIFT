import { describe, expect, it } from 'vitest';
import { RiftStore } from '../../src/storage/database.js';
import { seedWorkspace } from '../acceptance/fixtures.js';
import { dependencyContext } from '../../src/task/dependency-context.js';

describe('compact dependency context', () => {
  it('bounds summaries, retains references and excludes unrelated, failed and old attempt results', () => {
    const store = new RiftStore();
    try {
      const {workspace, roles} = seedWorkspace(store);
      const role = roles.find(item => item.purpose === 'developer')!;
      store.exec("INSERT INTO workflows(id,workspace_id,goal,status,integration_ref,base_commit) VALUES('w',?,'Goal','running','ref','base')", workspace.id);
      const task = (id:string, attempt=1) => store.exec("INSERT INTO tasks(id,workflow_id,kind,title,instructions,expected_paths,acceptance_criteria,status,attempt) VALUES(?,'w','analysis',?,'Inspect','[]','[]','succeeded',?)", id,id,attempt);
      const run = (id:string,taskId:string,attempt:number,status:string,summary:string,artifact:string|null=null) => { store.exec("INSERT INTO runs(id,task_id,role_id,purpose,task_attempt,status,provider_snapshot,cleanup_status,slot_released_at,deadline,result,result_artifact_id,created_at) VALUES(?,?,?,'develop',?,?,'{}','confirmed','now','later',?,?,'now')",id,taskId,role.id,attempt,status,JSON.stringify({summary}),null);
        if(artifact){
          store.exec("INSERT INTO artifacts(id,run_id,type,relative_path,sha256,byte_size,created_at) VALUES(?,?,'result','result.json','hash',1,'now')",artifact,id);
          store.exec('UPDATE runs SET result_artifact_id=? WHERE id=?',artifact,id);
        }
      };
      task('target');task('unrelated');run('unrelated-run','unrelated',1,'succeeded','DO NOT FORWARD');
      for(let i=0;i<6;i++){
        const id=`dep-${i}`;task(id,2);
        store.exec("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES('target',?)",id);
        run(`old-${i}`,id,1,'succeeded','OLD ATTEMPT');
        run(`good-${i}`,id,2,'succeeded',i===0?'token=private-value\n'+'中文'.repeat(3000):'x'.repeat(6000),`artifact-${i}`);
        run(`failed-${i}`,id,2,'failed','FAILED RESULT');
      }
      task('missing',2);run('only-old','missing',1,'succeeded','STALE');
      store.exec("INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES('target','missing')");
      const context=dependencyContext(store,store.task('target'));
      expect(context.tasks).toHaveLength(7);
      expect(context.tasks[0]).toMatchObject({runId:'good-0',resultArtifactId:'artifact-0',summaryTruncated:true});
      expect(context.tasks[0]!.summary).toContain('[REDACTED]');
      expect(context.tasks.at(-1)).toMatchObject({taskId:'missing',summary:null,runId:null,resultArtifactId:null});
      const encoded=JSON.stringify(context);
      for(const excluded of ['private-value','DO NOT FORWARD','OLD ATTEMPT','FAILED RESULT','STALE','�'])expect(encoded).not.toContain(excluded);
      expect(context.tasks.reduce((sum,item)=>sum+Buffer.byteLength(item.summary??''),0)).toBeLessThanOrEqual(8020);
    } finally {store.close();}
  });
});
