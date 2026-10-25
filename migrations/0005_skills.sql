CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX skills_workspace ON skills(workspace_id, archived);
CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version INTEGER NOT NULL,
  instructions TEXT NOT NULL,
  source_directory TEXT NOT NULL,
  digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
);
CREATE TRIGGER skill_versions_immutable_update BEFORE UPDATE ON skill_versions BEGIN SELECT RAISE(ABORT, 'Skill versions are immutable'); END;
CREATE TRIGGER skill_versions_immutable_delete BEFORE DELETE ON skill_versions BEGIN SELECT RAISE(ABORT, 'Skill versions are retained for execution history'); END;
CREATE TABLE skill_shared (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version_id TEXT NOT NULL REFERENCES skill_versions(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, skill_id)
);
CREATE TABLE skill_agent_assignments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES roles(id),
  skill_id TEXT NOT NULL REFERENCES skills(id),
  mode TEXT NOT NULL CHECK(mode IN ('include','exclude','inherit')),
  version_id TEXT REFERENCES skill_versions(id),
  revision INTEGER NOT NULL,
  PRIMARY KEY (agent_id, skill_id)
);
CREATE TABLE skill_execution_snapshots (
  owner_type TEXT NOT NULL CHECK(owner_type IN ('turn','run')),
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES roles(id),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);
CREATE TRIGGER skill_snapshots_immutable_update BEFORE UPDATE ON skill_execution_snapshots BEGIN SELECT RAISE(ABORT, 'Skill execution snapshots are immutable'); END;
CREATE TRIGGER skill_snapshots_immutable_delete BEFORE DELETE ON skill_execution_snapshots BEGIN SELECT RAISE(ABORT, 'Skill execution snapshots are retained'); END;
CREATE TRIGGER skill_insert_event AFTER INSERT ON skills BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at) VALUES(NEW.workspace_id,'skill.created',NEW.id,NEW.revision,NEW.created_at); END;
CREATE TRIGGER skill_update_event AFTER UPDATE ON skills BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at) VALUES(NEW.workspace_id,'skill.updated',NEW.id,NEW.revision,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER skill_version_event AFTER INSERT ON skill_versions BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,payload,occurred_at) VALUES((SELECT workspace_id FROM skills WHERE id=NEW.skill_id),'skill.version',NEW.id,NEW.version,json_object('skillId',NEW.skill_id),NEW.created_at); END;
CREATE TRIGGER skill_shared_insert_event AFTER INSERT ON skill_shared BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,payload,occurred_at) VALUES(NEW.workspace_id,'skill.shared',NEW.skill_id,NEW.revision,json_object('versionId',NEW.version_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER skill_shared_update_event AFTER UPDATE ON skill_shared BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,payload,occurred_at) VALUES(NEW.workspace_id,'skill.shared',NEW.skill_id,NEW.revision,json_object('versionId',NEW.version_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER skill_assignment_insert_event AFTER INSERT ON skill_agent_assignments BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,payload,occurred_at) VALUES(NEW.workspace_id,'skill.assignment',NEW.skill_id,NEW.revision,json_object('agentId',NEW.agent_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER skill_assignment_update_event AFTER UPDATE ON skill_agent_assignments BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,payload,occurred_at) VALUES(NEW.workspace_id,'skill.assignment',NEW.skill_id,NEW.revision,json_object('agentId',NEW.agent_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
INSERT INTO schema_migrations(version, applied_at) VALUES(5, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
