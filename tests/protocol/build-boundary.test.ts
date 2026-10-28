import { expect, it, vi } from 'vitest';
import config from '../../ui/vite.config.js';
import { fileURLToPath } from 'node:url';

// Exercise the production hook independently of the successful real UI build.
const plugins = config.plugins as { name?: string; generateBundle?: (this: unknown) => void }[];
const guard = plugins.find(plugin => plugin?.name === 'client-dependency-boundary')!;
it.each([
  fileURLToPath(new URL('../../src/api/ui-contracts.ts', import.meta.url)),
  '/node_modules/@deepseek-ai/dsh/index.js',
  'node:fs',
  '__vite-browser-external:node:path',
])('rejects server modules in the final browser graph: %s', id => {
  expect(() => guard.generateBundle!.call({ getModuleIds: () => [id], error: (message: string) => { throw new Error(message); } })).toThrow('Server dependency in browser build');
});
it('allows UI code, protocol output and browser dependencies', () => {
  const error = vi.fn();
  guard.generateBundle!.call({ getModuleIds: () => ['/ui/src/App.tsx', '/packages/protocol/dist/index.js', '/node_modules/react/index.js'], error });
  expect(error).not.toHaveBeenCalled();
});
