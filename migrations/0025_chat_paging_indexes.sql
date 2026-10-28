CREATE INDEX messages_conversation_time ON messages(conversation_id,created_at,id);
CREATE INDEX turn_stream_time ON turn_stream_messages(created_at,turn_id,message_id);
CREATE INDEX run_stream_time ON run_stream_messages(created_at,run_id,message_id);
CREATE INDEX turns_conversation_time ON agent_turns(conversation_id,created_at,id);
INSERT INTO schema_migrations(version,applied_at) VALUES(25,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
