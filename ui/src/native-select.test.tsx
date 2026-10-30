import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NativeSelect, NativeSelectOption, NativeSelectOptGroup } from './components/ui/native-select';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
describe('shared selection controls', () => {
  it('keeps original values and HTML validation/submission attributes in the native field', () => {
    const html = renderToStaticMarkup(<label>连接<NativeSelect name="connection" form="settings" defaultValue="" required aria-describedby="help">
      <NativeSelectOption value="">暂不配置</NativeSelectOption>
      <NativeSelectOption value="value:">真实前缀</NativeSelectOption>
      <NativeSelectOptGroup label="不可用" disabled><NativeSelectOption value="off">离线</NativeSelectOption></NativeSelectOptGroup>
    </NativeSelect></label>);
    expect(html).toMatch(/<button[^>]*role="combobox"[^>]*aria-required="true"/);
    expect(html).toMatch(/<select[^>]*name="connection"[^>]*form="settings"[^>]*required=""/);
    expect(html).toContain('<option value="" selected="">暂不配置</option>');
    expect(html).toContain('<option value="value:">真实前缀</option>');
    expect(html).toContain('<optgroup label="不可用" disabled="">');
  });

  it('keeps all 15 dropdown fields on the same adapter, with no page-local native selects', () => {
    const inventory = { 'Configuration.tsx': 3, 'ConnectionCatalogue.tsx': 1, 'RepositoryManager.tsx': 2, 'TaskActions.tsx': 1, 'pages.tsx': 4, 'SkillLibrary.tsx': 4 };
    for (const [file, count] of Object.entries(inventory)) expect(source(file).match(/<NativeSelect\b/g)?.length, file).toBe(count);
    for (const file of readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.tsx') && !f.includes('.test.'))) {
      expect(source(file), file).not.toMatch(/<select\b/);
    }
  });

  it('uses a themed portal rather than the platform popup, with bounded width and visible focus', () => {
    const component = source('components/ui/native-select.tsx');
    expect(component).toContain('<Select.Portal>');
    expect(component).toContain('position="popper"');
    const css = source('stitch.css');
    expect(css).toContain('max-height: var(--radix-select-content-available-height)');
    expect(css).toContain('max-width: calc(100vw - 24px)');
    expect(css).toContain('[data-slot=select-trigger]:focus-visible { outline: 2px solid var(--ring)');
  });
});
