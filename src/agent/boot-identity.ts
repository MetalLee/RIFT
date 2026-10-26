import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let cached: Promise<string | null> | undefined;

/** OS-issued boot identity, never Date.now()-uptime (clock changes are not reboots).
 * The machine component prevents copied databases from supplying cleanup proof.
 * Failure/unsupported platforms deliberately preserve unknown leases.
 */
export function localBootIdentity(): Promise<string | null> {
  return cached ??= (async () => {
    try {
      let machine: string, boot: string;
      if (process.platform === 'win32') {
        const script = "$ErrorActionPreference='Stop'; $riftBoot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); $riftMachine=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid; [Console]::Write((@{machine=$riftMachine;boot=$riftBoot}|ConvertTo-Json -Compress))";
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 4096 });
        const value: unknown = JSON.parse(stdout);
        if (!value || typeof value !== 'object') return null;
        const data = value as { machine?: unknown; boot?: unknown };
        if (typeof data.machine !== 'string' || typeof data.boot !== 'string') return null;
        machine = data.machine.trim(); boot = data.boot.trim();
      } else if (process.platform === 'linux') {
        [machine, boot] = (await Promise.all([readFile('/etc/machine-id', 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')])).map(value => value.trim()) as [string, string];
      } else if (process.platform === 'darwin') {
        const options = { timeout: 5000, maxBuffer: 65536 };
        const [{ stdout: hardware }, { stdout: session }] = await Promise.all([
          execute('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], options),
          execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], options),
        ]);
        const ids = [...hardware.matchAll(/"IOPlatformUUID"\s*=\s*"([^"]+)"/g)];
        if (ids.length !== 1) return null;
        machine = ids[0]![1]!.toLowerCase(); boot = session.trim().toLowerCase();
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        if (![machine, boot].every(value => uuid.test(value) && value !== '00000000-0000-0000-0000-000000000000')) return null;
      } else return null;
      if (!machine || !boot || machine.length > 256 || boot.length > 256) return null;
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      return `v1:${hash(machine)}:${hash(boot)}`;
    } catch { return null; }
  })();
}

/** Only a different OS boot on the same machine proves old local processes gone. */
export function provesPreviousBootExited(previous: string | null | undefined, current: string | null | undefined): boolean {
  const format = /^v1:([a-f0-9]{64}):([a-f0-9]{64})$/;
  const before = previous?.match(format), after = current?.match(format);
  return Boolean(before && after && before[1] === after[1] && before[2] !== after[2]);
}
