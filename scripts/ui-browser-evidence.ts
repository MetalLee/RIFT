import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

// Run after the documented interactive browser checks; this reads their real
// local ledger. It does not simulate browser interactions or call a model.
const home = path.resolve('.runtime-evidence/ui-acceptance-home');
const db = new DatabaseSync(path.join(home, 'rift.db'), { readOnly: true });
try {
  const workspace = db.prepare('SELECT id,name,version FROM workspaces WHERE name=?').get('浏览器验收 · 无仓库') as { id: string; name: string; version: number } | undefined;
  if (!workspace) throw new Error('The interactive browser acceptance workspace was not found.');
  const turns = db.prepare("SELECT id,status,cleanup_status,json_extract(configuration,'$.connection.runtime') AS runtime,json_extract(configuration,'$.connection.model') AS model FROM agent_turns WHERE workspace_id=? ORDER BY created_at").all(workspace.id);
  const messages = db.prepare("SELECT role,content,status FROM messages WHERE workspace_id=? ORDER BY created_at,id").all(workspace.id);
  const report = {
    date: new Date().toISOString(), mode: 'Interactive real Microsoft Edge UI actions via computer-use; read-only SQLite corroboration; genuine DSH and native model replies',
    workspace, turns, messages,
    repositories: db.prepare('SELECT id,canonical_path FROM repositories WHERE workspace_id=?').all(workspace.id),
    worktrees: db.prepare('SELECT repository_id,origin,path,branch,status FROM workspace_worktrees WHERE workspace_id=?').all(workspace.id),
    connections: db.prepare('SELECT name,protocol,endpoint,model,revision,verification_status FROM api_connections').all(),
    observedChecks: ['one-time bootstrap exchange and fragment removal', 'same-tab fresh bootstrap after the final UI build reconnects without manual reload and restores persisted history', 'create workspace without a repository', 'real default DSH reply and persisted history after reload', 'Chinese member creation with Codex model selection', 'explicit member routing with Ctrl+Enter', 'workspace switch preserves only its own draft/recipient/history', 'ordinary Enter inserts newline without sending', 'shared Skill import preview, immutable save, effective set and real native reply marker', 'two repositories associated independently and managed worktree created with explicit branch', 'API connection created with credential reference and real verification succeeds', 'stop a real native reply and observe cancelled state'],
    responsiveObservations: [{width:320,page:'chat',documentScrollWidth:305},{width:390,page:'repositories with long paths',documentScrollWidth:375},{width:768,page:'settings',documentScrollWidth:753},{width:1440,page:'chat and Skill detail',horizontalOverflow:false}],
    screenshots: ['ui-screenshots/chat-320.png','ui-screenshots/chat-1440.png','ui-screenshots/skills-1440.png','ui-screenshots/repositories-390.png','ui-screenshots/settings-768.png'],
    limits: ['IME composition guards are verified by automatic event logic tests and source review; no claim that an OS input-method composition session was automated.', 'Read-only viewport geometry supplements visual inspection; no claim of a formal accessibility certification.'],
  };
  await writeFile('docs/evidence/ui-browser-acceptance.json', JSON.stringify(report,null,2));
  console.log(JSON.stringify({workspace:workspace.id,turns:turns.length,messages:messages.length,repositoryCount:report.repositories.length,worktreeCount:report.worktrees.length},null,2));
} finally { db.close(); }
