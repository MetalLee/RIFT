CREATE TABLE workspace_path_grants (workspace_id TEXT NOT NULL REFERENCES workspaces(id), path TEXT NOT NULL, PRIMARY KEY(workspace_id,path));
ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_migrations(version,applied_at) VALUES(20,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
