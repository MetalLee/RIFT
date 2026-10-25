-- Foreign keys are disabled by the migration runner only while rebuilding roles.
CREATE TABLE roles_e1 (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), purpose TEXT NOT NULL CHECK(purpose IN ('lead','developer','reviewer')), kind TEXT NOT NULL CHECK(kind IN ('dsh-lead','subagent')), provider_binding_id TEXT REFERENCES provider_bindings(id), prompt TEXT NOT NULL, revision INTEGER NOT NULL, UNIQUE(workspace_id,name), CHECK((purpose='lead' AND kind='dsh-lead' AND provider_binding_id IS NULL) OR (purpose<>'lead' AND kind='subagent' AND provider_binding_id IS NOT NULL)));
INSERT INTO roles_e1 SELECT id,workspace_id,name,1,CASE name WHEN 'lead' THEN 'lead' WHEN 'reviewer' THEN 'reviewer' ELSE 'developer' END,kind,provider_binding_id,prompt,revision FROM roles;
DROP TABLE roles;
ALTER TABLE roles_e1 RENAME TO roles;
CREATE UNIQUE INDEX one_lead_per_workspace ON roles(workspace_id) WHERE purpose='lead' AND enabled=1;
ALTER TABLE provider_bindings ADD COLUMN runtime TEXT;
ALTER TABLE provider_bindings ADD COLUMN model TEXT;
ALTER TABLE provider_bindings ADD COLUMN spawn TEXT;
ALTER TABLE tasks ADD COLUMN analysis_items TEXT;
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100);
ALTER TABLE workflows ADD COLUMN last_scheduled INTEGER NOT NULL DEFAULT 0;
DROP INDEX one_active_workflow;
CREATE UNIQUE INDEX one_active_workflow ON workflows(workspace_id) WHERE status NOT IN ('completed','failed','cancelled');
CREATE TABLE scheduler_limits (id INTEGER PRIMARY KEY CHECK(id=1), developers INTEGER NOT NULL CHECK(developers BETWEEN 1 AND 128), total INTEGER NOT NULL CHECK(total BETWEEN 2 AND 129 AND total>developers), max_tasks INTEGER NOT NULL CHECK(max_tasks BETWEEN 1 AND 10000), max_replans INTEGER NOT NULL CHECK(max_replans BETWEEN 0 AND 1000), aging_ms INTEGER NOT NULL CHECK(aging_ms BETWEEN 1 AND 3600000), dispatch_sequence INTEGER NOT NULL DEFAULT 0);
INSERT INTO scheduler_limits(id,developers,total,max_tasks,max_replans,aging_ms) VALUES(1,2,3,1000,100,60000);
DROP TRIGGER run_global_capacity;
CREATE TRIGGER run_global_capacity BEFORE INSERT ON runs WHEN NEW.slot_released_at IS NULL AND ((SELECT count(*) FROM runs WHERE slot_released_at IS NULL)>=(SELECT total FROM scheduler_limits WHERE id=1) OR (NEW.purpose='review' AND (SELECT count(*) FROM runs WHERE slot_released_at IS NULL AND purpose='review')>=1) OR (NEW.purpose<>'review' AND (SELECT count(*) FROM runs WHERE slot_released_at IS NULL AND purpose<>'review')>=(SELECT developers FROM scheduler_limits WHERE id=1))) BEGIN SELECT RAISE(ABORT,'capacity exceeded'); END;
INSERT INTO schema_migrations(version,applied_at) VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
