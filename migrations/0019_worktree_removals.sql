-- Deletion receipts are independent of task/run/integration history. Unknown
-- cleanup retains the repository execution fence until explicit reconciliation.
CREATE TABLE worktree_removals (
  kind TEXT NOT NULL CHECK(kind IN ('user','task','candidate','review')),
  record_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  task_id TEXT REFERENCES tasks(id),
  path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('deleting','deleted','failed','unknown')),
  version INTEGER NOT NULL DEFAULT 1,
  source_fingerprint TEXT NOT NULL,
  cleanup_status TEXT NOT NULL,
  runtime_boot_id TEXT,
  error TEXT,
  head_commit TEXT,
  preservation_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(kind,record_id)
);
CREATE TRIGGER removal_execution_fence_insert BEFORE INSERT ON execution_leases
WHEN (NEW.released_at IS NULL OR NEW.cleanup_status<>'confirmed') AND EXISTS (
 SELECT 1 FROM worktree_removals d JOIN repositories r ON r.id=d.repository_id
 JOIN repositories other ON other.common_git_dir=r.common_git_dir
 WHERE d.state IN ('deleting','unknown') AND other.workspace_id=NEW.workspace_id
) BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_execution_fence_update BEFORE UPDATE ON execution_leases
WHEN (NEW.released_at IS NULL OR NEW.cleanup_status<>'confirmed') AND EXISTS (
 SELECT 1 FROM worktree_removals d JOIN repositories r ON r.id=d.repository_id
 JOIN repositories other ON other.common_git_dir=r.common_git_dir
 WHERE d.state IN ('deleting','unknown') AND other.workspace_id=NEW.workspace_id
) BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_operation_fence_insert BEFORE INSERT ON operations
WHEN NEW.phase IN ('queued','started') AND EXISTS (
 SELECT 1 FROM tasks t JOIN workflows f ON f.id=t.workflow_id
 JOIN repositories r ON r.workspace_id=f.workspace_id
 JOIN repositories owner ON owner.common_git_dir=r.common_git_dir
 JOIN worktree_removals d ON d.repository_id=owner.id
 WHERE t.id=NEW.entity_id AND d.state IN ('deleting','unknown')
) BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_operation_fence_update BEFORE UPDATE ON operations
WHEN NEW.phase IN ('queued','started') AND EXISTS (
 SELECT 1 FROM tasks t JOIN workflows f ON f.id=t.workflow_id
 JOIN repositories r ON r.workspace_id=f.workspace_id
 JOIN repositories owner ON owner.common_git_dir=r.common_git_dir
 JOIN worktree_removals d ON d.repository_id=owner.id
 WHERE t.id=NEW.entity_id AND d.state IN ('deleting','unknown')
) BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_user_record_fence BEFORE UPDATE ON workspace_worktrees
WHEN EXISTS (SELECT 1 FROM worktree_removals WHERE kind='user' AND record_id=OLD.id AND state IN ('deleting','unknown'))
BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_task_tree_fence BEFORE UPDATE ON worktrees
WHEN EXISTS (SELECT 1 FROM worktree_removals WHERE kind='task' AND record_id=OLD.id AND state IN ('deleting','unknown'))
BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_integration_fence BEFORE UPDATE ON integrations
WHEN EXISTS (SELECT 1 FROM worktree_removals WHERE kind IN ('candidate','review') AND record_id=OLD.id AND state IN ('deleting','unknown'))
BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
-- Freeze the selected task's metadata as well as its tree; a terminal task or
-- workflow must not become resumable between the final guard and Git removal.
CREATE TRIGGER removal_task_record_fence BEFORE UPDATE ON tasks
WHEN EXISTS (SELECT 1 FROM worktree_removals WHERE task_id=OLD.id AND state IN ('deleting','unknown'))
BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_workflow_record_fence BEFORE UPDATE ON workflows
WHEN EXISTS (SELECT 1 FROM worktree_removals d JOIN tasks t ON t.id=d.task_id WHERE t.workflow_id=OLD.id AND d.state IN ('deleting','unknown'))
BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_repository_record_fence BEFORE UPDATE ON repositories
WHEN EXISTS (SELECT 1 FROM worktree_removals d JOIN repositories r ON r.id=d.repository_id WHERE r.common_git_dir=OLD.common_git_dir AND d.state IN ('deleting','unknown'))
BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_workspace_binding_fence BEFORE UPDATE OF default_repository_id ON workspaces
WHEN EXISTS (SELECT 1 FROM worktree_removals WHERE workspace_id=OLD.id AND state IN ('deleting','unknown'))
BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
-- A new association/creation cannot attach to a path during its deletion.
CREATE TRIGGER removal_association_fence BEFORE INSERT ON workspace_worktrees
WHEN EXISTS (
 SELECT 1 FROM worktree_removals d JOIN repositories r ON r.id=d.repository_id
 JOIN repositories other ON other.common_git_dir=r.common_git_dir
 WHERE other.id=NEW.repository_id AND d.state IN ('deleting','unknown')
) BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_association_update_fence BEFORE UPDATE ON workspace_worktrees
WHEN EXISTS (
 SELECT 1 FROM worktree_removals d JOIN repositories r ON r.id=d.repository_id
 JOIN repositories other ON other.common_git_dir=r.common_git_dir
 WHERE other.id=NEW.repository_id AND d.state IN ('deleting','unknown')
) BEGIN SELECT RAISE(ABORT,'WORKTREE_DELETION_IN_PROGRESS'); END;
CREATE TRIGGER removal_insert_event AFTER INSERT ON worktree_removals BEGIN
 INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at)
 VALUES(NEW.workspace_id,'worktree.removal',NEW.record_id,NEW.version,NEW.updated_at);
END;
CREATE TRIGGER removal_update_event AFTER UPDATE ON worktree_removals BEGIN
 INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at)
 VALUES(NEW.workspace_id,'worktree.removal',NEW.record_id,NEW.version,NEW.updated_at);
END;
INSERT INTO schema_migrations(version,applied_at) VALUES(19,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
