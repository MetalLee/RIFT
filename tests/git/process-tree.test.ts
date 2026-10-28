import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { execute } from '../../src/git/process.js';

it('preserves normal results, output limits, literal arguments and spawn errors', async () => {
  const result = await execute(process.execPath, ['-e', 'console.log(process.argv[1]); console.error("err"); process.exitCode=7', 'a & "b"'], process.cwd());
  expect(result.exitCode).toBe(7); expect(result.stdout.trim()).toBe('a & "b"'); expect(result.stderr.trim()).toBe('err');
  const limited = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100))'], process.cwd(), { maxOutputBytes: 10 });
  expect(limited.stdout).toBe('x'.repeat(10)); expect(limited.truncated).toBe(true);
  await expect(execute('rift-nonexistent-command-987654', [], process.cwd())).rejects.toThrow();
});

it('terminates a descendant which ignores SIGTERM instead of only closing its pipes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rift-tree-'));
  let descendant: number | undefined;
  const file = path.join(directory, 'pid');
  const script = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setTimeout(()=>process.exit(),10000);'], {stdio:['ignore',1,2],windowsHide:true}); require('node:fs').writeFileSync(${JSON.stringify(file)}, String(child.pid)); setInterval(()=>{},1000);`;
  try {
    const result = await execute(process.execPath, ['-e', script], process.cwd(), { timeoutMs: 500 });
    expect(result.exitCode).toBe(124);
    descendant = Number(await readFile(file, 'utf8'));
    await expect.poll(() => { try { process.kill(descendant!, 0); return false; } catch { return true; } }, { timeout: 3000 }).toBe(true);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('kills the owned group even after the parent exits while its descendant retains pipes', async () => {
  const script = `require('node:child_process').spawn(process.execPath, ['-e','setTimeout(()=>{},10000)'], {stdio:['ignore',1,2]}).unref();`;
  const start = Date.now();
  const result = await execute(process.execPath, ['-e', script], process.cwd(), { timeoutMs: 150 });
  expect(result.exitCode).toBe(124); expect(Date.now()-start).toBeLessThan(1200);
});

it('streams large binary stdin without argv limits and retains early-exit diagnostics',async()=>{
  const input=Buffer.alloc(3*1024*1024,65);input[1]=0;
  const received=await execute(process.execPath,['-e',`let size=0,zero=false;process.stdin.on('data',b=>{size+=b.length;zero ||= b.includes(0);});process.stdin.on('end',()=>console.log(size+':'+zero));`],process.cwd(),{input});
  expect(received.exitCode).toBe(0);expect(received.stdout.trim()).toBe(input.length+':true');
  const early=await execute(process.execPath,['-e','console.error("INPUT_REJECTED");process.exit(7)'],process.cwd(),{input});
  expect(early.exitCode).toBe(7);expect(early.stderr).toContain('INPUT_REJECTED');
  await expect(execute('rift-nonexistent-command-987654',[],process.cwd(),{input})).rejects.toThrow();
  const timeout=await execute(process.execPath,['-e','setInterval(()=>{},1000)'],process.cwd(),{input,timeoutMs:150});expect(timeout.exitCode).toBe(124);
});
