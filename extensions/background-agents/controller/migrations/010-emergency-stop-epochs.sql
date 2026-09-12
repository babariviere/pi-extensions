-- Invalidate work that was running when an emergency stop was activated.

ALTER TABLE controller_control_state ADD COLUMN stop_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN stop_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE emergency_stop_attempts (
	stop_epoch INTEGER NOT NULL,
	attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
	systemd_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (systemd_confirmed IN (0, 1)),
	reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (stop_epoch, attempt_id)
);

CREATE INDEX emergency_stop_attempts_pending
	ON emergency_stop_attempts(stop_epoch, attempt_id)
	WHERE systemd_confirmed = 0 OR reconciled = 0;
