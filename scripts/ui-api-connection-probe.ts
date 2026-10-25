import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { initializeProfileFromDefault, runProfile } from '@deepseek-ai/dsh/profile-boot';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { RiftStore } from '../src/storage/database.js';
import { ApiConnectionService } from '../src/agent/connections.js';
import { publicError } from '../src/api/security.js';

if (!process.argv.includes('--real')) throw new Error('Pass --real to deliberately verify the saved API connection with a real model.');
const root = path.resolve('.runtime-evidence'); await mkdir(root, { recursive: true });
const home = await mkdtemp(path.join(root, 'ui-api-connection-'));
process.env.DSH_HOME = path.join(home, 'dsh'); process.env.RIFT_HOME = path.join(home, 'plugin'); process.env.RIFT_PORT = '0';
initializeProfileFromDefault('ui-api', 'sdk-minimal', process.env.DSH_HOME);
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('ui-api'), profile: 'ui-api', patchFiles: [path.resolve('profiles/rift.codex.patch.yml')], args: [] });
const store = new RiftStore(path.join(home, 'probe.db'));
const service = new ApiConnectionService(ctx, store, home);
const report: Record<string, unknown> = { date: new Date().toISOString(), mode: 'real persisted connection through official DSH pi-ai adapter and DeepSeek API; no business tools or repository access' };
try {
  await service.initialize();
  const connection = await service.create({ name: 'DeepSeek API 验收', protocol: 'openai-completions', endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', credentialRef: 'DEEPSEEK_API_KEY' });
  const verified = await service.verify(connection.id);
  report.connection = verified.connection; report.passed = verified.passed; report.error = verified.error;
  const revised = await service.create({ name: 'DeepSeek API 新版本', protocol: 'openai-completions', endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', credentialRef: 'DEEPSEEK_API_KEY', parentId: connection.id });
  report.revisionIsolation = revised.revision === 2 && revised.provider !== connection.provider && service.get(connection.id).provider === connection.provider;
  report.status = verified.passed && report.revisionIsolation ? 'pass' : 'fail';
} catch (error) { report.status = 'fail'; report.error = publicError(error); }
finally {
  await service.close(); store.close(); await shutdown.shutdown(0);
  await writeFile(path.resolve('docs/evidence/ui-api-connection-probe.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}
