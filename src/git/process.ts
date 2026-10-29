import { spawn } from 'node:child_process';
import { devNull } from 'node:os';

export interface CommandResult { exitCode: number; stdout: string; stderr: string; truncated: boolean }
/** No shell is involved; even spaces, quotes and metacharacters remain one argument. */
export function execute(executable: string, args: readonly string[], cwd: string, options: { timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv; input?: string|Buffer; signal?: AbortSignal } = {}): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.resolve({ exitCode: 130, stdout: '', stderr: 'Command cancelled before spawn.', truncated: false });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, ...options.env }, stdio: [options.input===undefined?'ignore':'pipe', 'pipe', 'pipe'] });
    const limit = options.maxOutputBytes ?? 1_048_576;
    let stdout = '', stderr = '', bytes = 0, truncated = false, timedOut = false, cancelled = false;
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const remaining = Math.max(0, limit - bytes);
      const part = chunk.subarray(0, remaining).toString('utf8');
      if (stream === 'stdout') stdout += part; else stderr += part;
      bytes += chunk.length; if (chunk.length > remaining) truncated = true;
    };
    child.stdout!.on('data', (data: Buffer) => capture(data, 'stdout'));
    child.stderr!.on('data', (data: Buffer) => capture(data, 'stderr'));
    let inputError:Error|undefined;
    child.stdin?.on('error',(error:Error)=>{inputError=error;});
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if(inputError&&!timedOut&&code===0){reject(inputError);return;}
      resolve({ exitCode: cancelled ? 130 : timedOut ? 124 : code ?? 1, stdout, stderr: stderr + (cancelled ? '\nCommand cancelled; execution cleanup requires verification.' : timedOut ? '\nCommand timed out; execution cleanup requires verification.' : ''), truncated });
    };
    const stopWaiting = (): void => { child.stdin?.destroy(); child.stdout!.destroy(); child.stderr!.destroy(); finish(124); };
    const stop = (aborted = false): void => {
      if (settled) return;
      cancelled = aborted; timedOut = !aborted;
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          // Kill descendants before the parent disappears from the Windows tree.
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          const watchdog = setTimeout(() => { killer.kill(); child.kill(); stopWaiting(); }, 500);
          killer.on('error', () => { clearTimeout(watchdog); child.kill(); stopWaiting(); });
          killer.on('close', code => { clearTimeout(watchdog); if (code !== 0) child.kill(); stopWaiting(); });
          return;
        } else {
          // Each command owns a process group. SIGKILL also handles descendants
          // which ignore SIGTERM or retain inherited stdout/stderr after exit.
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        }
      }
      // Escaped descendants can retain pipes indefinitely. Timeout is still
      // unknown cleanup evidence, never permission to release a safety lease.
      child.stdin?.destroy();
      child.stdout!.destroy();
      child.stderr!.destroy();
      finish(124);
    };
    const cancel = () => stop(true);
    const timer = setTimeout(stop, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); reject(error); } });
    child.on('close', code => finish(code));
    if(options.input!==undefined)child.stdin!.end(options.input);
  });
}

export async function git(cwd: string, args: readonly string[], options:{input?:string|Buffer}={}): Promise<CommandResult> {
  // Repository-controlled helpers must never execute in the credential-bearing Host.
  const env:NodeJS.ProcessEnv={...Object.fromEntries(Object.keys(process.env).filter(name=>/^(?:GIT_|NODE_OPTIONS$|LD_|DYLD_)/.test(name)).map(name=>[name,undefined])),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':devNull,GIT_TERMINAL_PROMPT:'0',GIT_MERGE_AUTOEDIT:'no'};
  const configuration=await execute('git',['config','--no-includes','--list'],cwd,{env});
  if(configuration.exitCode===0&&configuration.stdout.split('\n').some(line=>/^(?:include(?:if\.[^=]*)?\.|filter\.|credential\.|core\.(?:fsmonitor|sshcommand)|diff\..*\.(?:command|textconv)|merge\..*\.driver|core\.worktree)=?/i.test(line)))throw new Error('UNSAFE_GIT_CONFIG: repository helper/include configuration requires operator removal before Host Git operations.');
  const result = await execute('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], cwd, { env, maxOutputBytes: 8_388_608, input:options.input });
  if (result.truncated) throw new Error('Git output exceeds evidence limit');
  return result;
}
export async function gitOk(cwd: string, args: readonly string[], options:{input?:string|Buffer}={}): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.exitCode !== 0) throw new Error(`Git ${args[0] ?? 'command'} failed (${result.exitCode}): ${result.stderr}`);
  return result.stdout.trim();
}

/** NUL-delimited literal pathspecs preserve unusual names without growing argv. */
export async function stageSourcePaths(cwd:string,paths:readonly string[]):Promise<void> {
  if(!paths.length)return;
  if(paths.some(value=>!value||value.includes('\0')))throw new Error('INVALID_SOURCE_PATH');
  await gitOk(cwd,['--literal-pathspecs','add','--pathspec-from-file=-','--pathspec-file-nul'],{input:Buffer.from(paths.join('\0')+'\0')});
}

/** Git < 2.35 lacks worktree list -z. Preserve quoted/newline paths on that
 * version instead of treating a failed discovery as proof of deletion. */
export async function worktreePorcelain(cwd:string):Promise<string> {
  const nul=await git(cwd,['worktree','list','--porcelain','-z']);
  if(nul.exitCode===0)return nul.stdout;
  if(!/unknown (?:switch|option).*z/i.test(nul.stderr))throw new Error(`Git worktree list failed (${nul.exitCode}): ${nul.stderr}`);
  const plain=await gitOk(cwd,['-c','core.quotePath=false','worktree','list','--porcelain']);
  const unquote=(value:string)=>{
    if(!value.startsWith('"'))return value;
    const chunks:Buffer[]=[];const text=value.slice(1,-1);
    for(let i=0;i<text.length;){
      if(text[i]!=='\\'){let end=text.indexOf('\\',i);if(end<0)end=text.length;chunks.push(Buffer.from(text.slice(i,end)));i=end;continue;}
      i++;const octal=/^[0-7]{1,3}/.exec(text.slice(i));
      if(octal){chunks.push(Buffer.from([parseInt(octal[0],8)]));i+=octal[0].length;}
      else{const escapes:Record<string,string>={a:'\x07',b:'\b',t:'\t',n:'\n',v:'\v',f:'\f',r:'\r','"':'"','\\':'\\'};chunks.push(Buffer.from(escapes[text[i]!]??text[i]!));i++;}
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  return plain.split('\n').map(line=>line.startsWith('worktree ')?'worktree '+unquote(line.slice(9)):line).join('\0')+'\0\0';
}
