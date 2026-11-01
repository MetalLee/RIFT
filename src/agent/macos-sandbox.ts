import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { containsPath } from '../api/workspace-paths.js';

export interface SandboxMount { root: string; readOnly: boolean; masks: { path: string; directory: boolean }[] }
/** Seatbelt enforces the same filesystem grants without pretending macOS has
 * Linux mount/network namespaces. Only the validating egress proxy is reachable;
 * listening sockets are denied. Temporary files use a private TMPDIR. */
export async function macosSandboxCommand(mounts: SandboxMount[], home: string, homeMasks: SandboxMount['masks'], cwd: string, cmd: string, proxyUrl: string, resources?: string): Promise<string[]> {
  const temporary = path.join(home, '.tmp'); await mkdir(temporary, { recursive: true });
  const quote = (text: string) => JSON.stringify(text);
  const subpath = (value: string) => `(subpath ${quote(value)})`;
  const readOnly = mounts.filter(m => m.readOnly).map(m => m.root).concat(resources ? [resources] : []);
  const grants = [...mounts, { root: home, masks: homeMasks, readOnly: false }, ...resources ? [{ root: resources, masks: [], readOnly: true }] : []];
  const policy = ['(version 1)', '(deny default)', '(allow file-read* (literal "/"))', '(allow process-exec process-fork)', '(allow signal (target same-sandbox))', '(allow process-info* (target same-sandbox))', '(allow sysctl-read)', '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))'];
  const system = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/Library/Developer', '/opt/homebrew', '/private/var/db/dyld', '/private/var/select', '/private/etc/ssl'];
  for (const root of system) policy.push(`(allow file-read* ${subpath(root)})`);
  for (const file of ['/dev/null', '/dev/random', '/dev/urandom', '/private/etc/localtime', '/var', '/tmp', '/etc']) policy.push(`(allow file-read* (literal ${quote(file)}))`);
  policy.push('(allow file-write* (literal "/dev/null"))');
  const parents = new Set<string>(), immovable = new Set<string>();
  for (const grant of grants) {
    const masks = grant.masks.map(m => m.path);
    // Moving a masked ancestor would otherwise expose its contents under a new path.
    immovable.add(grant.root);
    for (const target of [...masks, ...readOnly].filter(p => containsPath(grant.root,p))) {
      for (let current=target; containsPath(grant.root,current); current=path.dirname(current)) {
        immovable.add(current); if(current===grant.root) break;
      }
    }
    const condition = (exclusions: string[]) => `(require-all ${subpath(grant.root)} ${exclusions.map(p => `(require-not ${subpath(p)})`).join(' ')})`;
    policy.push(`(allow file-read* ${condition(masks)})`);
    if (!grant.readOnly) policy.push(`(allow file-write* ${condition([...masks, ...readOnly.filter(p => containsPath(p, grant.root) || containsPath(grant.root, p))])})`);
    for (let parent = path.dirname(grant.root);; parent = path.dirname(parent)) { parents.add(parent); if (parent === path.dirname(parent)) break; }
  }
  for (const root of system) for(let parent=path.dirname(root);;parent=path.dirname(parent)){parents.add(parent);if(parent===path.dirname(parent))break;}
  for (const parent of parents) policy.push(`(allow file-read* (literal ${quote(parent)}))`);
  for (const target of immovable) policy.push(`(deny file-write-unlink (literal ${quote(target)}))`);
  const proxy = new URL(proxyUrl);
  policy.push(`(allow network-outbound (remote ip "localhost:${proxy.port}"))`);
  const bin = path.dirname(await realpath(process.execPath));
  const env = { HOME: home, TMPDIR: temporary, PATH: `${home}/.local/bin:${home}/.local/share/pnpm:${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', npm_config_prefix: home+'/.local', npm_config_cache: home+'/.npm', COREPACK_HOME: home+'/.cache/node/corepack', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', PNPM_HOME: home+'/.local/share/pnpm', XDG_CACHE_HOME: home+'/.cache', XDG_DATA_HOME: home+'/.local/share', XDG_CONFIG_HOME: home+'/.config', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' };
  // env -i is outside the sandbox so no inherited credentials or loader options
  // reach sandbox-exec, the shell, or its descendants.
  return ['/usr/bin/env', '-i', ...Object.entries(env).map(([key,value]) => `${key}=${value}`), '/usr/bin/sandbox-exec', '-p', policy.join('\n'), '/bin/bash', '--noprofile', '--norc', '-c', `cd -- ${"'"+cwd.replaceAll("'", "'\"'\"'")+"'"} && ${cmd}`];
}
