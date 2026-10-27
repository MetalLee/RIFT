import type { ApiConnection } from './ConnectionCatalogue.js';

export function ConnectionVerificationDetails({evidence}:{evidence:NonNullable<ApiConnection['verification']>}) {
  return <div className="connection-verification"><p>实际对话：{evidence.conversation?'已完成':'未完成'} · 工具执行：{evidence.toolCalls} 次 · 清理：{evidence.cleanupConfirmed?'已确认':'未确认'}</p>{evidence.stopReason&&<p>本次运行：{evidence.stopReason}</p>}{evidence.reply&&<details><summary>查看实际回复</summary><p>{evidence.reply}</p></details>}</div>;
}
