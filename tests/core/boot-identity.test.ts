import { describe, expect, it } from 'vitest';
import { localBootIdentity, provesPreviousBootExited } from '../../src/agent/boot-identity.js';

describe('orphan cleanup boot proof', () => {
  const machine = 'a'.repeat(64), anotherMachine = 'b'.repeat(64), boot = 'c'.repeat(64), nextBoot = 'd'.repeat(64);
  it('requires two valid OS identities on the same machine and different boots', () => {
    const old = `v1:${machine}:${boot}`;
    expect(provesPreviousBootExited(old, `v1:${machine}:${nextBoot}`)).toBe(true);
    expect(provesPreviousBootExited(old, old)).toBe(false);
    expect(provesPreviousBootExited(old, `v1:${anotherMachine}:${nextBoot}`)).toBe(false);
    expect(provesPreviousBootExited(null, old)).toBe(false);
    expect(provesPreviousBootExited(old, null)).toBe(false);
    expect(provesPreviousBootExited('invalid', old)).toBe(false);
  });
  it('caches the actual local OS observation and never infers a reboot from elapsed wall time', async () => {
    const first = localBootIdentity();
    expect(localBootIdentity()).toBe(first);
    const value = await first;
    if (value !== null) expect(value).toMatch(/^v1:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(provesPreviousBootExited(value, await localBootIdentity())).toBe(false);
  });
});
