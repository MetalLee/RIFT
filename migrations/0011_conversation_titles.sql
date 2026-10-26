-- Title summaries share the durable Lead queue and runtime cleanup leases.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','conversation_title'));
CREATE TRIGGER conversation_update_event AFTER UPDATE OF title ON conversations BEGIN
  INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at)
  VALUES(NEW.workspace_id,'conversation.updated',NEW.id,NEW.version,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
INSERT INTO schema_migrations(version,applied_at) VALUES(11,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
