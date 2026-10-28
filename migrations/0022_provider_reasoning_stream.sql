-- Preserve existing stream IDs, versions and replay cursors while adding the
-- provider's textual reasoning channel (distinct from a public summary).
CREATE TABLE turn_stream_messages_next (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES agent_turns(id),
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('assistant','commentary','final','reasoning','reasoning_summary')),
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'streaming' CHECK(status IN ('streaming','completed','interrupted')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(turn_id,message_id)
);
INSERT INTO turn_stream_messages_next SELECT * FROM turn_stream_messages;
DROP TABLE turn_stream_messages;
ALTER TABLE turn_stream_messages_next RENAME TO turn_stream_messages;
INSERT INTO schema_migrations(version,applied_at) VALUES(22,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
