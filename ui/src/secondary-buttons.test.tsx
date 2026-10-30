import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The 13 low-emphasis white-card actions must reuse the plain `secondary` variant used by
// "退出浏览器会话": no variant override, no dedicated class, no dedicated stylesheet rule.
const passthrough = (tag: string) => ({ asChild, variant: _v, ...props }: Record<string, unknown>) => React.createElement(asChildTag(asChild, tag), props);
const asChildTag = (asChild: unknown, tag: string) => asChild ? React.Fragment : tag;
vi.mock('./components/ui/button', () => ({ Button: ({ className, variant, children, ...props }: React.ComponentProps<'button'> & { variant?: string }) => React.createElement('button', { ...props, 'data-variant': variant, className }, children) }));
vi.mock('./components/ui/card', () => ({ Card: ({ children, asChild: _a, ...props }: { children: React.ReactNode; asChild?: boolean }) => React.createElement('div', props, children) }));
vi.mock('./components/ui/input', () => ({ Input: passthrough('input') }));
vi.mock('./components/ui/native-select', () => ({ NativeSelect: passthrough('select'), NativeSelectOption: passthrough('option') }));
vi.mock('./components/ui/textarea', () => ({ Textarea: passthrough('textarea') }));
vi.mock('./components/ui/checkbox', () => ({ Checkbox: passthrough('input') }));
vi.mock('./App', () => ({ Copy: () => null, Notice: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children), Icon: () => null }));
const { TaskRetry } = await import('./TaskActions');
const { WorkspaceControls } = await import('./WorkspaceControls');

const covered = ['WorkspaceControls', 'ConnectionCatalogue', 'SkillLibrary', 'RepositoryManager', 'TaskActions'];
const source = (file: string) => readFileSync(new URL(`./${file}.tsx`, import.meta.url), 'utf8');

const data = () => ({
  workspace: { id: 'w', name: '工作区', version: 1, status: 'active' },
  workflows: [{ id: 'wf', status: 'running' }],
  roles: [], repositories: [], runs: [], tasks: [], worktrees: [], presence: [],
  capabilities: { workflowActions: { available: true } },
}) as never;
const task = { id: 't', workflowId: 'wf', status: 'failed', version: 1, title: '任务', dependsOn: [], priority: 0 } as never;
const secondaries = (html: string) => [...html.matchAll(/<button[^>]*data-variant="secondary"[^>]*>[^<]*<\/button>/g)].map(m => m[0]);

describe('the 13 white-card actions reuse the shared secondary variant', () => {
  it('leaves the reference 退出浏览器会话 button untouched as a plain secondary', () => {
    const pages = readFileSync(new URL('./pages.tsx', import.meta.url), 'utf8');
    const ref = /<Button variant="secondary".*?>[^<]*退出浏览器会话[^<]*<\/Button>/.exec(pages);
    expect(ref, 'reference 退出浏览器会话 button changed').not.toBeNull();
    expect(ref![0]).not.toMatch(/className/);
  });

  it('has no dedicated on-card class or css rule left', () => {
    expect(readFileSync(new URL('./stitch.css', import.meta.url), 'utf8')).not.toMatch(/on-card/);
    for (const file of covered) expect(source(file), file).not.toMatch(/on-card/);
    expect(readFileSync(new URL('./stitch.css', import.meta.url), 'utf8')).toMatch(/^\.secondary \{ background: white;/m);
  });

  it('adds no class override to the covered actions, so they match the reference', () => {
    // Counts are the pre-existing plain secondary actions in these files; the 13 covered ones must
    // not add any new bounded class, so a stray override would change these numbers.
    const plain = (text: string) => (text.match(/<Button variant="secondary"(?![^>]*className)[^>]*>/g) ?? []).length;
    expect(Object.fromEntries(covered.map(f => [f, plain(source(f))]))).toEqual({
      WorkspaceControls: 2, ConnectionCatalogue: 3, SkillLibrary: 5, RepositoryManager: 3, TaskActions: 3,
    });
  });

  it('keeps the existing .secondary buttons outside the 13 untouched', () => {
    // These keep the original shared class and are not part of the 13.
    expect(source('WorkspaceControls')).toContain('variant="secondary" className="secondary" disabled={busy} onClick={() => setArchiving(false)}>保留工作区');
    expect(source('TaskActions')).toContain('variant="secondary" className="secondary" onClick={() => { setFrozen(');
    expect(source('RepositoryManager')).toContain('variant="secondary" onClick={() => { void load(); onChanged(); }}');
  });

  it('renders covered actions as plain secondary buttons with unchanged labels', () => {
    const retry = secondaries(renderToStaticMarkup(<TaskRetry task={task} data={data()} csrf="c" onChanged={() => {}} />));
    expect(retry).toEqual(['<button data-variant="secondary">准备重试</button>']);
    const controls = secondaries(renderToStaticMarkup(<WorkspaceControls data={data()} csrf="c" onChanged={() => {}} />));
    expect(controls).toEqual(['<button data-variant="secondary">重命名工作区</button>']);
    expect(`${retry}${controls}`).not.toContain('on-card');
  });
});
