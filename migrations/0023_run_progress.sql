CREATE TABLE run_progress (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  phase TEXT NOT NULL,
  tool_name TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  model_steps INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT INTO schema_migrations(version,applied_at) VALUES(23,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
