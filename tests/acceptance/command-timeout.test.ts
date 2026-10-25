import { expect, it } from 'vitest';
import { execute } from '../../src/git/process.js';

it('returns a bounded timeout even when a descendant retains inherited output pipes', async () => {
  // The descendant terminates itself after two seconds even on a failing implementation.
  // Returning 124 must remain an unknown-cleanup result; it must not claim the tree died.
  const startedAt = Date.now();
  const script = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000)'], { stdio: ['ignore', 1, 2], windowsHide: true }); setInterval(() => {}, 1000);`;
  const result = await execute(process.execPath, ['-e', script], process.cwd(), { timeoutMs: 150 });
  expect(result.exitCode).toBe(124);
  expect(result.stderr).toContain('cleanup requires verification');
  expect(Date.now() - startedAt).toBeLessThan(1200);
});
