-- Durable cleanup for runtime resources created by an attempt.
CREATE TABLE runtime_cleanup_intents (
	id TEXT PRIMARY KEY,
	attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('unit', 'tab')),
	resource_id TEXT NOT NULL,
	reason TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (attempt_id, kind, resource_id)
);
CREATE INDEX runtime_cleanup_intents_pending ON runtime_cleanup_intents(status, created_at) WHERE status = 'pending';
