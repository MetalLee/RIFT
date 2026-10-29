import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import { LocalGitService } from '../../src/git/integration.js';
import type { HostConfig } from '../../src/api/host-service.js';

const filename = fileURLToPath(new URL('../../profiles/rift.codex.frontend.patch.yml', import.meta.url));
// Parse through the same public DSH patch loader used by profile boot, not a hand-written YAML parser.
const patches = loadOverlayPatches('rift-profile-test', filename);
const entries = patches.flatMap(patch => Array.isArray(patch.insert) ? patch.insert : []);
const config = entries.find(entry => entry.id === 'rift')!.config as HostConfig;
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('explicit frontend Host profile', () => {
  it('loads a valid required serial plan with one install/protocol producer', () => {
    expect(config.checkPlan).toEqual({ mode: 'serial', maxConcurrency: 1, resourceSlots: 1 });
    expect(() => new LocalGitService({ managedRoot: '/unused-profile-test', commands: config.checks, checkPlan: config.checkPlan })).not.toThrow();
    expect(config.checks.map(check => check.id)).toEqual(['diff-check', 'frontend-install', 'frontend-protocol', 'frontend-unit', 'frontend-types', 'frontend-build', 'frontend-buttons-browser']);
    expect(config.checks.every(check => check.required === true && !check.environment && !check.baseline && !check.isolation)).toBe(true);
    expect(config.checks[1].args).toContain('--frozen-lockfile');
    expect(config.checks[1].args).toContain('--ignore-scripts');
    for (const check of config.checks.slice(3, 6)) {
      expect(check.dependsOn).toEqual(['frontend-protocol']);
      const script = pkg.scripts[check.args[0]];
      expect(script).toBeTruthy();
      expect(script).not.toContain('build:protocol');
    }
    expect(config.checks[6]).toMatchObject({ executable: 'node', dependsOn: ['frontend-build'], args: ['scripts/check-ui-browser.mjs', '/usr/local/lib/node_modules/playwright', '/usr/local/share/ms-playwright'] });
    expect(pkg.scripts['test:ui:prepared']).toContain('vitest run ui/src');
    expect(pkg.scripts['typecheck:ui:prepared']).toBe('tsc -p ui/tsconfig.json');
    expect(pkg.scripts['build:ui:prepared']).toBe('vite build --config ui/vite.config.ts ui');
  });

  it('keeps the explicit opt-in profile aligned with the existing Codex providers', () => {
    const original = readFileSync(new URL('../../profiles/rift.codex.patch.yml', import.meta.url), 'utf8');
    expect(readFileSync(filename, 'utf8').split('        # Explicit serial')[0]).toBe(original.split('        checks:')[0]);
    for (const script of ['test:ui', 'typecheck:ui', 'build:ui']) {
      expect(pkg.scripts[script]).toBe(`pnpm build:protocol && pnpm ${script}:prepared`);
    }
  });
});
