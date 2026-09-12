-- Durable operator controls and queued recovery context.

CREATE TABLE controller_control_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
	emergency_stop INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop IN (0, 1)),
	rollout_default TEXT NOT NULL DEFAULT 'observe' CHECK (rollout_default IN ('observe', 'supervised', 'autonomous-pr')),
	source_overrides TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_overrides)),
	repository_overrides TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(repository_overrides)),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO controller_control_state (id) VALUES (1);

CREATE TABLE operator_events (
	id TEXT PRIMARY KEY,
	event_type TEXT NOT NULL,
	actor TEXT NOT NULL,
	details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE attempts ADD COLUMN recovery_checkpoint_id TEXT REFERENCES recovery_checkpoints(id) ON DELETE SET NULL;

CREATE TRIGGER operator_events_append_only_update BEFORE UPDATE ON operator_events BEGIN
	SELECT RAISE(ABORT, 'operator_events is append-only');
END;
CREATE TRIGGER operator_events_append_only_delete BEFORE DELETE ON operator_events BEGIN
	SELECT RAISE(ABORT, 'operator_events is append-only');
END;
