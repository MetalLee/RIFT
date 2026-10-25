-- Runner temporarily disables FK enforcement while replacing only the parent
-- repository table, then checks every foreign key before committing.
CREATE TABLE repositories_v6 (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), canonical_path TEXT NOT NULL, common_git_dir TEXT NOT NULL, base_ref TEXT NOT NULL, UNIQUE(workspace_id,common_git_dir));
INSERT INTO repositories_v6 SELECT * FROM repositories;
DROP TABLE repositories;
ALTER TABLE repositories_v6 RENAME TO repositories;
ALTER TABLE workspaces ADD COLUMN default_repository_id TEXT REFERENCES repositories(id);
ALTER TABLE provider_bindings ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
UPDATE workspaces SET default_repository_id=(SELECT id FROM repositories WHERE workspace_id=workspaces.id ORDER BY id LIMIT 1);
CREATE TABLE workspace_worktrees (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), repository_id TEXT NOT NULL REFERENCES repositories(id), origin TEXT NOT NULL CHECK(origin IN ('managed','external')), path TEXT NOT NULL, pending_path TEXT, runtime_boot_id TEXT, base_commit TEXT NOT NULL, branch TEXT, status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX workspace_worktree_live_path ON workspace_worktrees(workspace_id,path) WHERE status NOT IN ('archived','detached','creation_failed');
CREATE TRIGGER workspace_worktree_scope BEFORE INSERT ON workspace_worktrees WHEN (SELECT workspace_id FROM repositories WHERE id=NEW.repository_id)<>NEW.workspace_id BEGIN SELECT RAISE(ABORT,'cross-workspace worktree'); END;
CREATE TRIGGER task_repository_scope BEFORE INSERT ON tasks WHEN NEW.repository_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_repositories WHERE workflow_id=NEW.workflow_id AND repository_id=NEW.repository_id) BEGIN SELECT RAISE(ABORT,'task repository not in workflow'); END;
CREATE TRIGGER repository_task_insert AFTER INSERT ON tasks WHEN NEW.repository_id IS NOT NULL BEGIN UPDATE workflow_repositories SET status='active' WHERE workflow_id=NEW.workflow_id AND repository_id=NEW.repository_id; END;
CREATE TRIGGER repository_task_progress AFTER UPDATE OF status ON tasks WHEN NEW.repository_id IS NOT NULL BEGIN UPDATE workflow_repositories SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM tasks WHERE workflow_id=NEW.workflow_id AND repository_id=NEW.repository_id AND status<>'succeeded') THEN 'completed' WHEN EXISTS(SELECT 1 FROM tasks WHERE workflow_id=NEW.workflow_id AND repository_id=NEW.repository_id AND status IN ('blocked','failed','cancelled')) THEN 'blocked' ELSE 'active' END WHERE workflow_id=NEW.workflow_id AND repository_id=NEW.repository_id; END;
CREATE TRIGGER repository_insert_event AFTER INSERT ON repositories BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,occurred_at) VALUES(NEW.workspace_id,'repository.connected',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER managed_worktree_insert_event AFTER INSERT ON workspace_worktrees BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at) VALUES(NEW.workspace_id,'worktree.created',NEW.id,NEW.version,NEW.created_at); END;
CREATE TRIGGER managed_worktree_update_event AFTER UPDATE ON workspace_worktrees BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at) VALUES(NEW.workspace_id,'worktree.updated',NEW.id,NEW.version,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
INSERT INTO schema_migrations(version,applied_at) VALUES(6,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
