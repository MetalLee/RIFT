/** One command vocabulary for the executable CLI and Host-bound agent tool. */
export const WORKSPACE_COMMANDS = {
  workspace: ['show','update','archive','paths','grant-path','revoke-path'],
  agent: ['list','show','create','update','disable','enable'],
  connection: ['list'],
  repository: ['list','show','connect','update','disconnect'],
  worktree: ['list','create','takeover','detach','archive','reconcile','removals','delete','reconcile-delete'],
  workflow: ['list','show','start','pause','resume','cancel','lead','finish','report','wait','yield'],
  plan: ['submit','replan'],
  task: ['list','show','update','delegate','dispatch','retry','cancel','recover-source','evidence'],
  run: ['list','show','logs','cancel','reconcile'],
  integration: ['list','request','reconcile'],
  conversation: ['list','create','show','rename','archive'],
  message: ['list','send','retry-delivery'],
  turn: ['show','stop','reconcile'],
  skill: ['list','show','preview','import','discard-preview','shared','assign','effective','archive','restore'],
  source: ['read'],
  event: ['list'], diagnostic: ['show'], queue: ['list'],
} as const;
export function workspaceCommandHelp() {
  return { usage: 'rift ws <resource> <action> [id] --workspace ID [--data JSON | --file JSON_FILE] [--key KEY]', commands: WORKSPACE_COMMANDS,
    scope: 'Agent rift_cli uses the same resource/action/id argv and JSON input. Host fixes workspace and execution identity. grant-path/revoke-path are operator-only.',
    concurrency: 'Use expectedVersion / expectedRevision from a fresh read. Retry writes with the SAME --key and input; a different operation needs a new key.' };
}
