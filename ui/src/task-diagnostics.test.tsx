import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { UiTask } from '@rift/protocol';
import { TaskDiagnostics, taskIssueSummary } from './TaskDiagnostics';

it('shows the test blocker separately from timeout and subsequent coordination failure', () => {
  const task = { blockingReason:'CANCELLED', diagnostics:{ runId:'run-1',attempt:1,status:'cancelled',stopReason:'TIMEOUT',error:'Run was cancelled.',
    report:{id:'report',kind:'progress',content:'Vitest: spawn EPERM <script>unsafe()</script>',createdAt:'2026-10-26T13:44:44Z'},
    coordination:{turnId:'turn-1',error:'thread lead already has an active writer',createdAt:'2026-10-26T14:00:46Z'},
  }} as UiTask;
  expect(taskIssueSummary(task)).toBe('执行超时，任务已停止');
  const html = renderToStaticMarkup(<TaskDiagnostics task={task} />);
  for (const text of ['spawn EPERM','TIMEOUT','后续协调失败','active writer','未经独立验证']) expect(html).toContain(text);
  expect(html).not.toContain('<script>');
});
