import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AgentEditor, LeadEditor } from './Configuration';
import type { UiWorkspaceDetail } from '@rift/protocol';
const data={workspace:{id:'w',version:2,leadConnection:{runtime:'dsh',provider:'api',model:'execution-model'}},roles:[{id:'lead',kind:'dsh-lead',purpose:'lead',version:1,name:'lead',prompt:'Plan',chatConnection:{runtime:'dsh',provider:'api',model:'discussion-model'}}],bindings:[],leadConfiguration:{runtime:'dsh',provider:'api',model:'default-model'}} as unknown as UiWorkspaceDetail;
it('exposes independent execution and discussion fields in both Lead configuration entrypoints',()=>{
 for(const component of [<AgentEditor data={data} agentId="lead" csrf="" onClose={()=>{}} onSaved={()=>{}}/>,<LeadEditor data={data} csrf="" onSaved={()=>{}}/>]){
  const html=renderToStaticMarkup(component);
  expect(html).toContain('name="execution_model"');expect(html).toContain('value="execution-model"');
  expect(html).toContain('name="model"');expect(html).toContain('value="discussion-model"');
  expect(html).not.toContain('请在系统设置中配置');
 }
});
