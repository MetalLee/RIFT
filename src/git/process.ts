import { spawn } from 'node:child_process';
import { devNull } from 'node:os';

export interface CommandResult { exitCode: number; stdout: string; stderr: string; truncated: boolean }
/** No shell is involved; even spaces, quotes and metacharacters remain one argument. */
export function execute(executable: string, args: readonly string[], cwd: string, options: { timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd, shell: false, windowsHide: true, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const limit = options.maxOutputBytes ?? 1_048_576;
    let stdout = '', stderr = '', bytes = 0, truncated = false, timedOut = false;
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const remaining = Math.max(0, limit - bytes);
      const part = chunk.subarray(0, remaining).toString('utf8');
      if (stream === 'stdout') stdout += part; else stderr += part;
      bytes += chunk.length; if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on('data', (data: Buffer) => capture(data, 'stdout'));
    child.stderr.on('data', (data: Buffer) => capture(data, 'stderr'));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 120_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: timedOut ? 124 : code ?? 1, stdout, stderr: stderr + (timedOut ? '\nCommand timed out; execution cleanup requires verification.' : ''), truncated }); });
  });
}

export async function git(cwd: string, args: readonly string[]): Promise<CommandResult> {
  const result = await execute('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], cwd, { env: { GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' }, maxOutputBytes: 8_388_608 });
  if (result.truncated) throw new Error('Git output exceeds evidence limit');
  return result;
}
export async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw new Error(`Git ${args[0] ?? 'command'} failed (${result.exitCode}): ${result.stderr}`);
  return result.stdout.trim();
}
