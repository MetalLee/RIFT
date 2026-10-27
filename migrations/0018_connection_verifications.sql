CREATE TABLE api_connection_verifications (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES api_connections(id),
  created_at TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE INDEX connection_verifications_latest ON api_connection_verifications(connection_id, created_at);
INSERT INTO schema_migrations(version,applied_at) VALUES(18,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
