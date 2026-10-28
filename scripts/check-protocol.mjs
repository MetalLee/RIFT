import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);

export function checkImports(text, file, protocol, options = {}) {
  const imports = ts.preProcessFile(text, true, true);
  assert.equal(imports.typeReferenceDirectives.length, 0, `Ambient dependency in ${file}`);
  assert.equal(imports.referencedFiles.length, 0, `Reference dependency in ${file}`);
  for (const { fileName: specifier } of imports.importedFiles) {
    if (protocol) {
      assert(specifier.startsWith('./'), `External protocol dependency: ${specifier} in ${file}`);
      assert(!relative(dirname(file), resolve(dirname(file), specifier)).startsWith('..'), `Escaping protocol dependency: ${specifier}`);
    } else {
      assert(!/^(?:node:|@deepseek-ai\/|rift(?:\/|$))/.test(specifier), `Server dependency: ${specifier}`);
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
      assert(!resolved || !resolve(resolved).replaceAll('\\', '/').startsWith(join(root, 'src').replaceAll('\\', '/') + '/'), `UI backend dependency: ${specifier} in ${file}`);
    }
  }
}

export async function checkProtocol() {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/protocol/package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.exports, { '.': { types: './dist/index.d.ts', import: './dist/index.js' } });
  for (const directory of ['src', 'dist']) for (const file of files(join(root, 'packages/protocol', directory))) {
    const text = readFileSync(file, 'utf8');
    checkImports(text, file, true);
    if (file.endsWith('.js')) assert.equal(text.trim(), 'export {};', `Protocol has runtime implementation: ${file}`);
  }
  const config = ts.readConfigFile(join(root, 'ui/tsconfig.json'), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'ui'));
  for (const file of files(join(root, 'ui/src')).filter(file => /\.[cm]?[jt]sx?$/.test(file))) checkImports(readFileSync(file, 'utf8'), file, false, options);

  // A consumer receives only the published entry and build output, with no repo, Node types or aliases.
  const temporary = mkdtempSync(join(tmpdir(), 'rift-protocol-'));
  try {
    const packageDirectory = join(temporary, 'node_modules/@rift/protocol');
    mkdirSync(packageDirectory, { recursive: true });
    cpSync(join(root, 'packages/protocol/dist'), join(packageDirectory, 'dist'), { recursive: true });
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(temporary, 'package.json'), '{"type":"module"}');
    cpSync(join(root, 'tests/protocol/consumer.fixture.ts'), join(temporary, 'consumer.ts'));
    const program = ts.createProgram([join(temporary, 'consumer.ts')], {
      target: ts.ScriptTarget.ES2023, lib: ['lib.es2023.d.ts'], module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, types: [], noEmit: true, skipLibCheck: false,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => temporary, getCanonicalFileName: file => file, getNewLine: () => '\n',
    }));
    for (const file of program.getSourceFiles()) assert(file.fileName.startsWith(temporary) || file.fileName.startsWith(dirname(require.resolve('typescript'))), `Unexpected consumer dependency: ${file.fileName}`);
    writeFileSync(join(temporary, 'runtime.mjs'), "export * from '@rift/protocol';\n");
    const runtime = await import(pathToFileURL(join(temporary, 'runtime.mjs')).href);
    assert.deepEqual(Object.keys(runtime), []);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  console.log('Protocol: isolated package consumer, empty runtime, and UI/server boundary passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkProtocol();
