CREATE TABLE turn_stream_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES agent_turns(id),
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('assistant','commentary','final','reasoning_summary')),
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'streaming' CHECK(status IN ('streaming','completed','interrupted')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(turn_id,message_id)
);
-- Tool events are independently consumable by API clients, without snapshot polling.
DROP TRIGGER turn_activity_event;
CREATE TRIGGER turn_activity_event AFTER INSERT ON turn_activities BEGIN
  INSERT INTO workspace_events(workspace_id,type,entity_id,payload,occurred_at)
  VALUES((SELECT workspace_id FROM agent_turns WHERE id=NEW.turn_id),'turn.activity',NEW.turn_id,
    json_object('activitySeq',NEW.seq,'turnVersion',(SELECT version+CASE WHEN status IN ('queued','running','stopping') OR NEW.type IN ('cleanup.confirmed','cleanup.unknown') THEN 1 ELSE 0 END FROM agent_turns WHERE id=NEW.turn_id),
      'updatesPhase',(SELECT status IN ('queued','running','stopping') OR NEW.type IN ('cleanup.confirmed','cleanup.unknown') FROM agent_turns WHERE id=NEW.turn_id),
      'activity',json_object('seq',NEW.seq,'turnId',NEW.turn_id,'type',NEW.type,'phase',NEW.phase,
        'toolName',NEW.tool_name,'toolCallId',NEW.tool_call_id,'summary',NEW.summary,'payload',json(NEW.payload),'createdAt',NEW.created_at)),NEW.created_at);
END;
ALTER TABLE agent_turns ADD COLUMN first_model_event_at TEXT;
ALTER TABLE agent_turns ADD COLUMN first_visible_text_at TEXT;
INSERT INTO schema_migrations(version,applied_at) VALUES(21,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
