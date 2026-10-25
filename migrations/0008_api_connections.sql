CREATE TABLE api_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK(protocol IN ('openai-completions','openai-responses','anthropic-messages')),
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  provider TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  parent_id TEXT REFERENCES api_connections(id),
  created_at TEXT NOT NULL,
  verified_at TEXT,
  verification_status TEXT NOT NULL DEFAULT 'not-verified',
  verification_error TEXT
);
INSERT INTO schema_migrations(version,applied_at) VALUES(8,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
