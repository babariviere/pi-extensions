-- Durable per-item approvals and usage pauses.

CREATE TABLE work_item_approvals (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
	spec_version INTEGER NOT NULL CHECK (spec_version > 0),
	decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
	actor TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX work_item_approvals_item_created ON work_item_approvals(work_item_id, created_at DESC, id DESC);

CREATE TABLE usage_paused_jobs (
	job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
	attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
	profile_id TEXT,
	reason TEXT NOT NULL,
	paused_at TEXT NOT NULL,
	resumed_at TEXT,
	PRIMARY KEY (job_id, attempt_id)
);

CREATE INDEX usage_paused_jobs_active ON usage_paused_jobs(job_id) WHERE resumed_at IS NULL;

CREATE TRIGGER work_item_approvals_append_only_update BEFORE UPDATE ON work_item_approvals BEGIN
	SELECT RAISE(ABORT, 'work_item_approvals is append-only');
END;
CREATE TRIGGER work_item_approvals_append_only_delete BEFORE DELETE ON work_item_approvals BEGIN
	SELECT RAISE(ABORT, 'work_item_approvals is append-only');
END;

ALTER TABLE attempts ADD COLUMN publish_invalidated INTEGER NOT NULL DEFAULT 0 CHECK (publish_invalidated IN (0, 1));
