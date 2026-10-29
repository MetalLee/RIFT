import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The 13 white-card secondary actions opt in to `.on-card`; guard against it leaking elsewhere.
const dir = new URL('.', import.meta.url);
const sources = readdirSync(dir).filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx')).map(f => [f, readFileSync(new URL(f, dir), 'utf8')] as const);
const count = (text: string) => (text.match(/className="secondary on-card"/g) ?? []).length;

describe('secondary buttons on white cards', () => {
  it('applies on-card to exactly the 13 authorised buttons', () => {
    const perFile = Object.fromEntries(sources.map(([f, t]) => [f, count(t)]).filter(([, n]) => n));
    expect(perFile).toEqual({ 'WorkspaceControls.tsx': 2, 'ConnectionCatalogue.tsx': 2, 'SkillLibrary.tsx': 4, 'RepositoryManager.tsx': 2, 'TaskActions.tsx': 3 });
  });
  it('scopes the style to .secondary.on-card so plain .secondary is untouched', () => {
    const css = readFileSync(new URL('stitch.css', dir), 'utf8');
    expect(css).toMatch(/^\.secondary\.on-card \{/m);
    expect(css).toMatch(/^\.secondary \{ background: white;/m);
  });
});
