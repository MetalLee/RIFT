import type { ChatConnection, UiBinding, UiWorkspaceDetail } from '@rift/protocol';
import { Icon } from './components/Icon';

export interface ModelLine { key: 'chat' | 'execution'; label: string; model: string; source: string; configured: boolean; runtime?: 'dsh' | 'codex' }
type Role = UiWorkspaceDetail['roles'][number];

/** Runtime labels only: raw provider keys embed API connection ids and stay out of the list. */
const runtimeLabel = (connection: ChatConnection) => connection.runtime === 'codex' ? 'Codex 原生运行时' : '模型 API';

export function modelLines(role: Role, binding: UiBinding | undefined, lead: UiWorkspaceDetail['leadConfiguration']): ModelLine[] {
  const line = (key: ModelLine['key'], label: string, model: string, source: string, runtime?: 'dsh' | 'codex'): ModelLine => ({ key, label, model: model || '未配置', source, configured: Boolean(model), runtime });
  if (role.kind === 'dsh-lead') return [
    line('chat', '对话', lead.model, lead.source === 'host' ? '继承本机配置' : runtimeLabel(lead), lead.runtime),
    line('execution', '执行', lead.model, '主 Agent 编排通道', lead.runtime),
  ];
  const execution = binding?.executionConnection ?? null;
  const inherited = !execution && binding && binding.providerName !== 'discussion-only' ? binding.model : null;
  const [chat, exec] = role.chatConnection
    ? [line('chat', '对话', role.chatConnection.model, runtimeLabel(role.chatConnection), role.chatConnection.runtime), execution ? line('execution', '执行', execution.model, runtimeLabel(execution), execution.runtime) : inherited ? line('execution', '执行', inherited, '继承默认执行') : line('execution', '执行', '', '仅对话')]
    : execution ? [line('chat', '对话', execution.model, '沿用执行连接', execution.runtime), line('execution', '执行', execution.model, runtimeLabel(execution), execution.runtime)] : [line('chat', '对话', '', '可在配置中添加连接'), inherited ? line('execution', '执行', inherited, '继承默认执行') : line('execution', '执行', '', '仅对话')];
  return [chat, exec];
}

export function AgentModels({ lines }: { lines: ModelLine[] }) {
  return <div className="agent-connection">{lines.map(line => <div className={`agent-model${line.configured ? '' : ' is-empty'}`} key={line.key}>
    <span className="agent-model-label">{line.label}</span>
    <div className="agent-model-body"><strong title={line.model}><Icon name={line.runtime === 'codex' ? 'terminal' : 'network'} size={15} />{line.model}</strong><span title={line.source}>{line.source}</span></div>
  </div>)}</div>;
}
