import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
it('does not redeclare protocol wire types in the backend', () => {
  const declarations = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true).statements.filter(statement => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement));
  const names = new Set(files('packages/protocol/src').flatMap(file => declarations(file).map(declaration => declaration.name.text)));
  for (const file of files('src').filter(file => file.endsWith('.ts'))) for (const declaration of declarations(file)) {
    if (!names.has(declaration.name.text)) continue;
    // Execution versions extend the wire metadata with full, immutable resource bytes.
    expect(file).toBe(path.join('src', 'skill', 'service.ts'));
    expect(declaration.name.text).toBe('SkillVersion');
    expect(ts.isInterfaceDeclaration(declaration) && declaration.heritageClauses?.[0]?.getText()).toContain("Omit<import('@rift/protocol').SkillVersion, 'resources'>");
  }
});
