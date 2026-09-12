-- Track the exact jobs paused by each emergency-stop activation.

CREATE TABLE emergency_stop_paused_jobs (
	job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
	paused_at TEXT NOT NULL,
	resumed_at TEXT,
	PRIMARY KEY (job_id, paused_at)
);

CREATE INDEX emergency_stop_paused_jobs_active ON emergency_stop_paused_jobs(job_id) WHERE resumed_at IS NULL;
