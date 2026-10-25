CREATE TABLE native_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  scope TEXT NOT NULL CHECK(scope IN ('chat','task')),
  scope_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES roles(id),
  configuration_key TEXT NOT NULL,
  thread_id TEXT,
  runtime_home TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id,scope,scope_id,agent_id,configuration_key),
  UNIQUE(runtime_home,thread_id)
);
CREATE TABLE native_executions (
  execution_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES native_sessions(id),
  native_turn_id TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE native_message_receipts (
  session_id TEXT NOT NULL REFERENCES native_sessions(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  message_version INTEGER NOT NULL,
  PRIMARY KEY(session_id,message_id,message_version)
);
INSERT INTO schema_migrations(version,applied_at) VALUES(9,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
