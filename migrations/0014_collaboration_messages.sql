DROP TRIGGER message_scope;
DROP TRIGGER reply_scope;
DROP TRIGGER message_insert_event;
DROP TRIGGER message_update_event;
ALTER TABLE messages RENAME TO messages_legacy;
CREATE TABLE messages (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
 client_message_id TEXT, recipient_agent_id TEXT REFERENCES roles(id), role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
 content TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,reply_to_message_id TEXT REFERENCES messages(id),
 kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','conversation_title','discussion','delegation','receipt','progress','result','blocker')),
 sender_type TEXT NOT NULL DEFAULT 'user' CHECK(sender_type IN ('user','agent','system')),sender_agent_id TEXT REFERENCES roles(id),
 origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','model','host')),visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','internal')),
 workflow_id TEXT REFERENCES workflows(id),task_id TEXT REFERENCES tasks(id),run_id TEXT REFERENCES runs(id),source_turn_id TEXT REFERENCES agent_turns(id),request_id TEXT REFERENCES operations(id),correlation_id TEXT,dedupe_key TEXT,automatic_hops INTEGER NOT NULL DEFAULT 0,
 UNIQUE(workspace_id,client_message_id),UNIQUE(workspace_id,dedupe_key),CHECK((sender_type='agent')=(sender_agent_id IS NOT NULL))
);
INSERT INTO messages(id,workspace_id,conversation_id,client_message_id,recipient_agent_id,role,content,status,version,created_at,reply_to_message_id,kind,sender_type,sender_agent_id,origin,visibility)
 SELECT id,workspace_id,conversation_id,client_message_id,recipient_agent_id,role,content,status,version,created_at,reply_to_message_id,kind,CASE role WHEN 'assistant' THEN 'agent' ELSE 'user' END,CASE role WHEN 'assistant' THEN recipient_agent_id ELSE NULL END,CASE role WHEN 'assistant' THEN 'model' ELSE 'user' END,CASE kind WHEN 'conversation_title' THEN 'internal' ELSE 'public' END FROM messages_legacy;
DROP TABLE messages_legacy;
CREATE TRIGGER message_legacy_identity AFTER INSERT ON messages WHEN NEW.role<>'user' AND NEW.sender_type='user' BEGIN UPDATE messages SET sender_type=CASE NEW.role WHEN 'system' THEN 'system' ELSE 'agent' END,sender_agent_id=CASE NEW.role WHEN 'assistant' THEN NEW.recipient_agent_id ELSE NULL END,origin=CASE NEW.role WHEN 'system' THEN 'host' ELSE 'model' END WHERE id=NEW.id; END;
CREATE TRIGGER message_scope BEFORE INSERT ON messages WHEN
 NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND workspace_id=NEW.workspace_id)
 OR (NEW.recipient_agent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM roles WHERE id=NEW.recipient_agent_id AND workspace_id=NEW.workspace_id))
 OR (NEW.sender_agent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM roles WHERE id=NEW.sender_agent_id AND workspace_id=NEW.workspace_id))
 OR (NEW.workflow_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflows WHERE id=NEW.workflow_id AND workspace_id=NEW.workspace_id))
 OR (NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks t JOIN workflows f ON f.id=t.workflow_id WHERE t.id=NEW.task_id AND f.workspace_id=NEW.workspace_id AND (NEW.workflow_id IS NULL OR f.id=NEW.workflow_id)))
 OR (NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs r JOIN tasks t ON t.id=r.task_id JOIN workflows f ON f.id=t.workflow_id WHERE r.id=NEW.run_id AND f.workspace_id=NEW.workspace_id AND (NEW.task_id IS NULL OR r.task_id=NEW.task_id)))
 OR (NEW.source_turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent_turns WHERE id=NEW.source_turn_id AND workspace_id=NEW.workspace_id AND conversation_id=NEW.conversation_id))
 OR (NEW.request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations o JOIN tasks t ON t.id=o.entity_id JOIN workflows f ON f.id=t.workflow_id WHERE o.id=NEW.request_id AND f.workspace_id=NEW.workspace_id AND (NEW.task_id IS NULL OR t.id=NEW.task_id)))
 BEGIN SELECT RAISE(ABORT,'cross-workspace message'); END;
CREATE TRIGGER reply_scope BEFORE INSERT ON messages WHEN NEW.reply_to_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.reply_to_message_id AND workspace_id=NEW.workspace_id AND conversation_id=NEW.conversation_id) BEGIN SELECT RAISE(ABORT,'cross-scope reply'); END;
CREATE TRIGGER message_insert_event AFTER INSERT ON messages BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at) VALUES(NEW.workspace_id,'message.created',NEW.id,NEW.version,NEW.created_at); END;
CREATE TRIGGER message_update_event AFTER UPDATE ON messages BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at) VALUES(NEW.workspace_id,'message.updated',NEW.id,NEW.version,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
ALTER TABLE turn_triggers RENAME TO turn_triggers_legacy;
CREATE TABLE turn_triggers (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), agent_id TEXT NOT NULL REFERENCES roles(id), kind TEXT NOT NULL CHECK(kind IN ('task_event','manual_wake','agent_message','user_message')), dedupe_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','consumed','failed','interrupted')), turn_id TEXT, error TEXT, created_at TEXT NOT NULL, ended_at TEXT);
INSERT INTO turn_triggers SELECT * FROM turn_triggers_legacy;
DROP TABLE turn_triggers_legacy;
CREATE TABLE collaboration_operations (scope TEXT NOT NULL, operation_key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope,operation_key));
CREATE TABLE agent_inbox (id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),recipient_agent_id TEXT NOT NULL REFERENCES roles(id),task_id TEXT REFERENCES tasks(id),automatic_hops INTEGER NOT NULL DEFAULT 0,scope TEXT NOT NULL CHECK(scope IN ('discussion','task')),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','consumed','failed','interrupted')),execution_id TEXT,error TEXT,created_at TEXT NOT NULL,consumed_at TEXT);
CREATE INDEX inbox_pending ON agent_inbox(status,recipient_agent_id,created_at);
CREATE TRIGGER inbox_insert_event AFTER INSERT ON agent_inbox BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,payload,occurred_at) VALUES(NEW.workspace_id,'inbox.created',NEW.message_id,json_object('messageId',NEW.message_id,'recipientAgentId',NEW.recipient_agent_id,'status',NEW.status),NEW.created_at); END;
CREATE TRIGGER inbox_update_event AFTER UPDATE OF status ON agent_inbox WHEN NEW.status<>OLD.status BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,payload,occurred_at) VALUES(NEW.workspace_id,'inbox.updated',NEW.message_id,json_object('messageId',NEW.message_id,'recipientAgentId',NEW.recipient_agent_id,'status',NEW.status),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TABLE run_input_boundaries (run_id TEXT PRIMARY KEY REFERENCES runs(id),captured_at TEXT NOT NULL);
CREATE TABLE run_inbox_receipts (run_id TEXT NOT NULL REFERENCES runs(id),inbox_id TEXT NOT NULL REFERENCES agent_inbox(id),message_id TEXT NOT NULL REFERENCES messages(id),message_version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'captured' CHECK(status IN ('captured','accepted')),PRIMARY KEY(run_id,inbox_id));
INSERT INTO schema_migrations(version,applied_at) VALUES(14,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
