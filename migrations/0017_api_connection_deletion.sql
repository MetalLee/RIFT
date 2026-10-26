ALTER TABLE api_connections ADD COLUMN deleted_at TEXT;
ALTER TABLE api_connections ADD COLUMN credential_deleted_at TEXT;
ALTER TABLE api_connections ADD COLUMN credential_owned INTEGER NOT NULL DEFAULT 0 CHECK(credential_owned IN (0,1));
-- Previous releases generated this exact random per-connection reference only
-- for directly entered keys. Do not claim arbitrary prefixed or shared refs.
UPDATE api_connections AS c SET credential_owned=1
WHERE length(c.id)=47 AND c.id LIKE 'connection-________-____-____-____-____________'
  AND length(replace(substr(c.id,12),'-',''))=32
  AND replace(substr(c.id,12),'-','') NOT GLOB '*[^0-9a-f]*'
  AND c.credential_ref='RIFT_API_' || upper(replace(substr(c.id,12),'-',''))
  AND NOT EXISTS(SELECT 1 FROM api_connections other WHERE other.id<>c.id AND other.credential_ref=c.credential_ref);
INSERT INTO schema_migrations(version,applied_at) VALUES(17,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
