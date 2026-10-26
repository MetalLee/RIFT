-- Safe drafts reuse message_chunks; final messages replace drafts by source_turn_id.
-- Phase/text activity already has dedicated events. Keep the workspace/presence
-- projection responsive to actual lifecycle changes without refreshing it on
-- every model delta or diagnostic timestamp update.
DROP TRIGGER turn_update_event;
CREATE TRIGGER turn_update_event AFTER UPDATE OF status,cleanup_status ON agent_turns
WHEN NEW.status<>OLD.status OR NEW.cleanup_status<>OLD.cleanup_status
BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at)
VALUES(NEW.workspace_id,'turn.updated',NEW.id,NEW.version,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
DROP TRIGGER turn_update_event;
CREATE TRIGGER turn_update_event AFTER UPDATE OF status,cleanup_status ON agent_turns WHEN OLD.status IS NOT NEW.status OR OLD.cleanup_status IS NOT NEW.cleanup_status BEGIN INSERT INTO workspace_events(workspace_id,type,entity_id,entity_version,occurred_at) VALUES(NEW.workspace_id,'turn.updated',NEW.id,NEW.version,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
INSERT INTO schema_migrations(version,applied_at) VALUES(15,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
