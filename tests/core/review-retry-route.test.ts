import {describe,expect,it,vi} from 'vitest';
import { ApplicationCommands } from '../../src/application/commands.js';
import { resolveHttpCommand } from '../../src/api/command-routes.js';
import type { RiftHostService } from '../../src/api/host-service.js';

describe('browser review retry routing',()=>{
  it.each(['failed','interrupted','blocked','changes_requested'])('routes %s without accidentally starting development for blocked review',async status=>{
    const task={id:'task',workflowId:'workflow',status:'blocked',sourceHead:'a'.repeat(40),version:7,attempt:1};
    const run={taskAttempt:1,purpose:'review',status:['failed','interrupted'].includes(status)?status:'succeeded',result:{verdict:status}};
    const requestIntegration=vi.fn(()=>({id:'integration-request'})),dispatch=vi.fn(()=>({id:'development-request'}));
    const retry=vi.fn(()=>({...task,status:'ready',version:8,attempt:2}));
    const host={store:{task:()=>task,workflow:()=>({workspaceId:'ws'}),get:(sql:string)=>sql.includes('FROM runs')?run:undefined},coordinator:{assertDevelopmentRetry:vi.fn(),requestIntegration,dispatch,retry}};
    const commands=new ApplicationCommands(host as unknown as RiftHostService);
    await commands.execute(resolveHttpCommand('POST','/ui-api/v1/workspaces/ws/tasks/task/retry',{expectedVersion:7,reason:'Environment recovered'}));
    if(status==='changes_requested'){
      expect(requestIntegration).not.toHaveBeenCalled();expect(dispatch).toHaveBeenCalledOnce();expect(retry).toHaveBeenCalledOnce();
    }else{
      expect(requestIntegration).toHaveBeenCalledWith({taskId:'task',sourceHead:task.sourceHead,expectedVersion:7,idempotencyKey:'browser-review-retry:task:7'});
      expect(dispatch).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();
    }
  });
});
