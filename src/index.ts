import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { RiftHostService, type HostConfig } from './api/host-service.js';
import { startLocalApi } from './api/local-api.js';
import { limitsSchema } from './api/schemas.js';
export const name = 'rift';
export const inject = ['agents','subagents','tools','llm'];
export { RiftHostService } from './api/host-service.js';
export { TaskCoordinator } from './task/coordinator.js';
export { RiftStore } from './storage/database.js';
export { LocalGitService } from './git/integration.js';
export { DshActivationBridge } from './task/activation-bridge.js';
export * from './contracts/index.js';
const configSchema=z.object({home:z.string().min(1),port:z.number().int().min(0).max(65535).default(47831),leadProvider:z.string().min(1).default('deepseek-official'),leadModel:z.string().min(1).default('deepseek-flash'),developerProvider:z.string().min(1).default('claude-code-dev'),reviewerProvider:z.string().min(1).default('codex-review'),limits:limitsSchema.optional(),runTimeoutMs:z.number().int().positive().optional(),checks:z.array(z.object({id:z.string().min(1),executable:z.string().min(1),args:z.array(z.string()),timeoutMs:z.number().int().positive().optional()})).min(1)}).strict();
export async function apply(ctx:Context, config:HostConfig):Promise<()=>Promise<void>>{
  const service=new RiftHostService(ctx,configSchema.parse(config));
  try {await service.initialize();const api=await startLocalApi(service,config);return async()=>{await api.close();await service.close();};}
  catch(error){await service.close();throw error;}
}
