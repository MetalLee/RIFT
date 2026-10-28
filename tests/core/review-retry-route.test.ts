import {describe,expect,it,vi} from 'vitest';
import {RiftHostService} from '../../src/api/host-service.js';

describe('browser review retry routing',()=>{
  it.each(['failed','interrupted','blocked','changes_requested'])('routes %s without accidentally starting development for blocked review',async status=>{
    const task={id:'task',workflowId:'workflow',status:'blocked',sourceHead:'a'.repeat(40),version:7};
    const run={purpose:'review',status:['failed','interrupted'].includes(status)?status:'succeeded',result:{verdict:status}};
    const requestIntegration=vi.fn(()=>({id:'integration-request'})),dispatch=vi.fn(()=>({id:'development-request'}));
    const route=vi.fn(async()=>({...task,status:'ready',version:8,attempt:2}));
    const host={store:{task:()=>task,workflow:()=>({workspaceId:'ws'}),get:()=>run},coordinator:{requestIntegration,dispatch},route};
    await (RiftHostService.prototype as any).routeBrowser.call(host,'POST','/ui-api/v1/workspaces/ws/tasks/task/retry',{expectedVersion:7,reason:'Environment recovered'});
    if(status==='changes_requested'){
      expect(requestIntegration).not.toHaveBeenCalled();expect(dispatch).toHaveBeenCalledOnce();expect(route).toHaveBeenCalledOnce();
    }else{
      expect(requestIntegration).toHaveBeenCalledWith({taskId:'task',sourceHead:task.sourceHead,expectedVersion:7,idempotencyKey:'browser-review-retry:task:7'});
      expect(dispatch).not.toHaveBeenCalled();expect(route).not.toHaveBeenCalled();
    }
  });
});
