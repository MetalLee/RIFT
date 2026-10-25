ALTER TABLE runs ADD COLUMN result_artifact_id TEXT REFERENCES artifacts(id);
INSERT INTO schema_migrations(version,applied_at) VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
