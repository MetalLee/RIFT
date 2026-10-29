-- Alternate request keys remain bound to the original execution across replay/restart.
CREATE TABLE operation_request_keys (
  dedupe_key TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id)
);
INSERT INTO schema_migrations(version,applied_at) VALUES(26,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
