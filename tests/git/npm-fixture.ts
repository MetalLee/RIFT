import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execute } from '../../src/git/process.js';

// Tracked tarball and lockfile keep real npm ci deterministic without registry access.
export async function writeOfflineNpmFixture(root: string, repo: string) {
  const pack = path.join(root, 'pack'); await mkdir(path.join(pack, 'package'), { recursive: true });
  await writeFile(path.join(pack, 'package', 'package.json'), JSON.stringify({ name: 'offline-dependency', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'exit 99' } }));
  await writeFile(path.join(pack, 'package', 'index.js'), 'module.exports="installed";\n');
  const tarball = path.join(repo, 'dependency.tgz');
  const packed = await execute('tar', ['-czf', tarball, '-C', pack, 'package'], root);
  if (packed.exitCode !== 0) throw new Error(packed.stderr);
  const integrity = 'sha512-' + createHash('sha512').update(await readFile(tarball)).digest('base64');
  const manifest = { name: 'offline-fixture', version: '1.0.0', dependencies: { 'offline-dependency': 'file:dependency.tgz' }, scripts: { postinstall: 'exit 98' } };
  await writeFile(path.join(repo, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(repo, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': manifest, 'node_modules/offline-dependency': { version: '1.0.0', resolved: 'file:dependency.tgz', integrity, hasInstallScript: true } } }));
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
}
