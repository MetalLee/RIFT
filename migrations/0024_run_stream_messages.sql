CREATE TABLE run_stream_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('assistant','commentary','final','reasoning_summary')),
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'streaming' CHECK(status IN ('streaming','completed','interrupted')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id,message_id)
);
INSERT INTO schema_migrations(version,applied_at) VALUES(24,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
