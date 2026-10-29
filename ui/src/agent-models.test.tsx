import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { UiBinding, UiWorkspaceDetail } from '@rift/protocol';
import { AgentModels, modelLines } from './AgentModels';

const lead = { source: 'host', runtime: 'dsh', provider: 'rift-api-secret-id', model: 'lead-model' } as UiWorkspaceDetail['leadConfiguration'];
const role = (extra: object) => ({ id: 'r', kind: 'subagent', ...extra }) as UiWorkspaceDetail['roles'][number];
const binding = (extra: object) => ({ id: 'b', providerName: 'spawn', model: null, ...extra }) as UiBinding;
const html = (lines: ReturnType<typeof modelLines>) => renderToStaticMarkup(<AgentModels lines={lines} />);

it('renders chat and execution with the same structure and never exposes API ids', () => {
  const chat = { runtime: 'dsh', provider: 'rift-api-abc123', model: 'gpt-chat' }, exec = { runtime: 'dsh', provider: 'rift-api-def456', model: 'gpt-exec' };
  const out = html(modelLines(role({ chatConnection: chat }), binding({ executionConnection: exec }), lead));
  expect(out.match(/class="agent-model"/g)).toHaveLength(2);
  for (const text of ['对话', '执行', 'gpt-chat', 'gpt-exec', '模型 API']) expect(out).toContain(text);
  expect(out).not.toMatch(/rift-api|abc123|def456|spawn/);
  expect(html(modelLines(role({ kind: 'dsh-lead' }), undefined, lead))).not.toContain('rift-api');
});

it('shows unconfigured and inherited states without leaking binding names', () => {
  const none = modelLines(role({ chatConnection: null }), binding({ providerName: 'discussion-only' }), lead);
  expect(none.map(l => [l.model, l.source, l.configured])).toEqual([['未配置', '可在配置中添加连接', false], ['未配置', '仅对话', false]]);
  const inherited = modelLines(role({ chatConnection: { runtime: 'codex', model: 'codex-m' } }), binding({ model: 'm1' }), lead);
  expect(inherited.map(l => [l.model, l.source])).toEqual([['codex-m', 'Codex 原生运行时'], ['m1', '继承默认执行']]);
  expect(html(inherited)).not.toContain('spawn');
});
