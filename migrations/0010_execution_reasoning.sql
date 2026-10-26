ALTER TABLE provider_bindings ADD COLUMN reasoning_effort TEXT;
INSERT INTO schema_migrations(version,applied_at) VALUES(10,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
