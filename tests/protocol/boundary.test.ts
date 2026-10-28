import { describe, expect, it } from 'vitest';
// @ts-expect-error The dependency guard is also directly runnable with Node.
import { checkImports, checkProtocol } from '../../scripts/check-protocol.mjs';
import { resolve } from 'node:path';

describe('client dependency boundary', () => {
  it('consumes only the built package entry without repo sources or Node types', async () => { await checkProtocol(); });
  it.each(["import type { X } from 'node:fs'", "export type { X } from '../../src/storage/database.js'", "type X = import('@deepseek-ai/dsh').X", '/// <reference types="node" />'])('rejects protocol dependencies: %s', source => {
    expect(() => checkImports(source, resolve('packages/protocol/src/probe.ts'), true)).toThrow();
  });
  it.each(["import type { X } from '../../src/api/ui-contracts'", "type X = import('../../src/chat/contracts.js').ChatPage", "export type { X } from '@deepseek-ai/dsh'"])('rejects UI server dependencies: %s', source => {
    expect(() => checkImports(source, resolve('ui/src/probe.ts'), false, { moduleResolution: 100 })).toThrow();
  });
});
