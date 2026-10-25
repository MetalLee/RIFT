import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import '@deepseek-ai/dsh-llm';
const evidence = path.resolve('.runtime-evidence');
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(path.join(evidence, 'lead-catalog-'));
process.env.DSH_HOME = path.join(root, 'dsh-home');
const patch = path.join(root, 'patch.yml');
await writeFile(patch, '- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n');
initializeProfileFromDefault('rift-catalog', 'sdk-minimal', process.env.DSH_HOME);
const runtime = await runProfile({ environment: loadLayeredEnv('rift-catalog'), profile: 'rift-catalog', patchFiles: [patch], args: [] });
try {
  const result = { at: new Date().toISOString(), providers: runtime.ctx.llm.listProviders(), models: await runtime.ctx.llm.listModels('deepseek-official'), modelCalls: 0 };
  await writeFile(path.join(evidence, 'lead-catalog-probe.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await runtime.shutdown.shutdown(0); }
