import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { execute, read } = vi.hoisted(() => ({ execute: vi.fn(), read: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
vi.mock('node:fs/promises', () => ({ readFile: read }));
const machine = '12345678-1234-1234-1234-123456789abc';
const boot = 'abcdef01-1234-1234-1234-123456789abc';
const next = 'abcdef02-1234-1234-1234-123456789abc';
function platform(value: string) { vi.stubGlobal('process', { ...process, platform: value }); }
function darwin(hardware = `"IOPlatformUUID" = "${machine}"`, session = boot) {
  platform('darwin');
  execute.mockImplementation(async (file: string) => ({ stdout: file.endsWith('ioreg') ? hardware : session }));
}
async function observe() { vi.resetModules(); return (await import('../../src/agent/boot-identity.js')).localBootIdentity(); }
beforeEach(() => { execute.mockReset(); read.mockReset(); vi.resetModules(); });
afterEach(() => vi.unstubAllGlobals());
describe('OS boot identity acquisition (mocked platforms)', () => {
  it('uses exact macOS OS tools, normalizes UUID case and caches the observation', async () => {
    darwin(`  "IOPlatformUUID" = "${machine.toUpperCase()}"`, ` ${boot.toUpperCase()}\n`);
    const mod = await import('../../src/agent/boot-identity.js');
    const first = mod.localBootIdentity();
    expect(mod.localBootIdentity()).toBe(first);
    const id = await first;
    expect(id).toMatch(/^v1:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(execute).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], expect.objectContaining({ timeout: 5000, maxBuffer: 65536 }));
    expect(execute).toHaveBeenCalledWith('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], expect.any(Object));
    darwin(); expect(await observe()).toBe(id);
    darwin(undefined, next);
    expect(mod.provesPreviousBootExited(id, await observe())).toBe(true);
    darwin(`"IOPlatformUUID" = "${next}"`, next);
    expect(mod.provesPreviousBootExited(id, await observe())).toBe(false);
  });
  it.each([
    ['', boot], [`"IOPlatformUUID" = "${machine}"`, ''],
    [`"IOPlatformUUID" = "${machine}"`, '1700000000'],
    [`"IOPlatformUUID" = "${machine}"`, `${boot}\n${next}`],
    ['"IOPlatformUUID" = "unknown"', boot],
    [`"IOPlatformUUID" = "${machine}"\n"IOPlatformUUID" = "${machine}"`, boot],
    [`"IOPlatformUUID" = "${machine}"`, '00000000-0000-0000-0000-000000000000'],
  ])('preserves unknown occupancy for malformed hardware/session evidence %s %s', async (hardware, session) => {
    darwin(hardware, session); expect(await observe()).toBeNull();
  });
  it('fails closed on denied, unavailable or timed-out tools and caches failure', async () => {
    darwin(); execute.mockRejectedValue(new Error('EPERM / timeout'));
    const mod = await import('../../src/agent/boot-identity.js');
    expect(await mod.localBootIdentity()).toBeNull();
    execute.mockClear(); expect(await mod.localBootIdentity()).toBeNull(); expect(execute).not.toHaveBeenCalled();
  });
  it('retains Linux and Windows acquisition and rejects unsupported platforms', async () => {
    platform('linux'); read.mockImplementation(async (file: string) => file === '/etc/machine-id' ? machine : boot);
    const linux = await observe(); expect(linux).toMatch(/^v1:/); expect(execute).not.toHaveBeenCalled();
    platform('win32'); execute.mockResolvedValue({ stdout: JSON.stringify({ machine, boot }) });
    expect(await observe()).toBe(linux);
    expect(execute).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({ windowsHide: true, timeout: 15000 }));
    platform('freebsd'); expect(await observe()).toBeNull();
  });
});
