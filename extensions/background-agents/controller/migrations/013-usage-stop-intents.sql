-- Keep provider-triggered runtime termination independent from paused job state.

CREATE TABLE usage_stop_intents (
	id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
	job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	profile_id TEXT,
	systemd_unit TEXT,
	pane_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'systemd-confirmed', 'pane-confirmed', 'complete')),
	systemd_confirmed INTEGER NOT NULL CHECK (systemd_confirmed IN (0, 1)),
	pane_confirmed INTEGER NOT NULL CHECK (pane_confirmed IN (0, 1)),
	reason TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX usage_stop_intents_pending ON usage_stop_intents(status, created_at) WHERE status <> 'complete';
CREATE INDEX usage_stop_intents_case ON usage_stop_intents(case_id, status);
