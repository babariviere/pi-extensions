-- Background agents schema version 1. All timestamps are UTC ISO-8601 values.

CREATE TABLE cases (
	id TEXT PRIMARY KEY,
	state TEXT NOT NULL DEFAULT 'intake' CHECK (state IN (
		'intake', 'classified', 'investigating', 'question-analysis', 'specification',
		'awaiting-approval', 'implementation', 'verification', 'pull-request-review',
		'paused', 'paused-usage', 'blocked', 'retry', 'handled', 'cancelled'
	)),
	title TEXT NOT NULL,
	repository TEXT,
	source TEXT NOT NULL CHECK (source IN ('manual', 'slack', 'linear', 'datadog')),
	priority INTEGER NOT NULL DEFAULT 0,
	rollout_mode TEXT NOT NULL DEFAULT 'observe' CHECK (rollout_mode IN ('observe', 'supervised', 'autonomous-pr')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE case_events (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	from_state TEXT CHECK (from_state IS NULL OR from_state IN (
		'intake', 'classified', 'investigating', 'question-analysis', 'specification',
		'awaiting-approval', 'implementation', 'verification', 'pull-request-review',
		'paused', 'paused-usage', 'blocked', 'retry', 'handled', 'cancelled'
	)),
	to_state TEXT NOT NULL CHECK (to_state IN (
		'intake', 'classified', 'investigating', 'question-analysis', 'specification',
		'awaiting-approval', 'implementation', 'verification', 'pull-request-review',
		'paused', 'paused-usage', 'blocked', 'retry', 'handled', 'cancelled'
	)),
	actor TEXT NOT NULL,
	reason TEXT,
	metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	CHECK ((from_state IS NULL AND to_state = 'intake') OR from_state IS NOT NULL)
);

CREATE TABLE source_events (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
	source TEXT NOT NULL CHECK (source IN ('manual', 'slack', 'linear', 'datadog')),
	source_key TEXT NOT NULL,
	revision TEXT NOT NULL DEFAULT '',
	received_at TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	fingerprint TEXT,
	repository TEXT,
	service TEXT,
	metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (source, source_key, revision)
);

CREATE TABLE classifications (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	input_kind TEXT NOT NULL CHECK (input_kind IN ('error', 'bug-report', 'feature', 'question', 'maintenance', 'other', 'unknown')),
	disposition TEXT NOT NULL CHECK (disposition IN ('actionable', 'noise', 'ambiguous')),
	actionability REAL NOT NULL CHECK (actionability BETWEEN 0 AND 100),
	noise REAL NOT NULL CHECK (noise BETWEEN 0 AND 100),
	confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 100),
	rationale TEXT NOT NULL,
	fingerprint TEXT,
	model_version TEXT NOT NULL,
	policy_version TEXT NOT NULL,
	influential_examples TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(influential_examples)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE case_relations (
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	related_case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	relation_type TEXT NOT NULL CHECK (relation_type IN ('duplicate', 'recurrence', 'related')),
	score REAL NOT NULL CHECK (score BETWEEN 0 AND 100),
	rationale TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	PRIMARY KEY (case_id, related_case_id, relation_type),
	CHECK (case_id <> related_case_id)
);

CREATE TABLE memory_entries (
	id TEXT PRIMARY KEY,
	case_id TEXT REFERENCES cases(id) ON DELETE SET NULL,
	finding TEXT NOT NULL,
	outcome TEXT,
	root_cause TEXT,
	evidence_summary TEXT NOT NULL,
	confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 100),
	scope TEXT NOT NULL,
	approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
	supersedes_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE feedback (
	id TEXT PRIMARY KEY,
	case_id TEXT REFERENCES cases(id) ON DELETE SET NULL,
	classification_id TEXT REFERENCES classifications(id) ON DELETE SET NULL,
	correction TEXT NOT NULL CHECK (json_valid(correction)),
	actor TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE classifier_policies (
	id TEXT PRIMARY KEY,
	scope TEXT NOT NULL,
	version TEXT NOT NULL,
	policy TEXT NOT NULL CHECK (json_valid(policy)),
	status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'retired')),
	proposed_by TEXT NOT NULL,
	activated_by TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	activated_at TEXT,
	UNIQUE (scope, version)
);

CREATE TABLE spec_versions (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	version INTEGER NOT NULL CHECK (version > 0),
	specification TEXT NOT NULL CHECK (json_valid(specification)),
	decisions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(decisions)),
	unresolved_questions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(unresolved_questions)),
	permissions TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permissions)),
	material_hash TEXT NOT NULL,
	planner_summary TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (case_id, version)
);

CREATE TABLE approvals (
	id TEXT PRIMARY KEY,
	spec_version_id TEXT NOT NULL REFERENCES spec_versions(id) ON DELETE CASCADE,
	decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes-requested')),
	actor TEXT NOT NULL,
	permissions TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permissions)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE work_items (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	ordinal INTEGER NOT NULL CHECK (ordinal > 0),
	parent_id TEXT REFERENCES work_items(id) ON DELETE RESTRICT,
	title TEXT NOT NULL,
	branch TEXT,
	worktree TEXT,
	pull_request INTEGER,
	state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'implementation', 'verification', 'verified', 'blocked', 'cancelled')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (case_id, ordinal)
);

CREATE TABLE jobs (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
	role TEXT NOT NULL CHECK (role IN ('classifier', 'investigator', 'spec-planner', 'worker', 'verifier')),
	state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'paused', 'needs-human')),
	priority INTEGER NOT NULL DEFAULT 0,
	claimed_by TEXT,
	claimed_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE attempts (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK (role IN ('classifier', 'investigator', 'spec-planner', 'worker', 'verifier')),
	generation INTEGER NOT NULL CHECK (generation > 0),
	state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'paused', 'needs-human')),
	profile_id TEXT,
	model TEXT,
	systemd_unit TEXT,
	pane_id TEXT,
	worktree TEXT,
	branch TEXT,
	heartbeat_at TEXT,
	started_at TEXT,
	finished_at TEXT,
	failure TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (job_id, generation)
);

CREATE TABLE attempt_leases (
	id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
	owner TEXT NOT NULL,
	generation INTEGER NOT NULL CHECK (generation > 0),
	expires_at TEXT NOT NULL,
	last_renewed_at TEXT NOT NULL,
	CHECK (expires_at > last_renewed_at)
);

CREATE TABLE evidence_manifests (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	version INTEGER NOT NULL CHECK (version > 0),
	base_sha TEXT NOT NULL,
	candidate_sha TEXT NOT NULL,
	commands TEXT NOT NULL CHECK (json_valid(commands)),
	environment_requirements TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(environment_requirements)),
	outputs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(outputs)),
	checksums TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checksums)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (case_id, version)
);

CREATE TABLE verification_runs (
	id TEXT PRIMARY KEY,
	manifest_id TEXT NOT NULL REFERENCES evidence_manifests(id) ON DELETE CASCADE,
	verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'needs-human')),
	confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 100),
	ci_checks TEXT NOT NULL CHECK (json_valid(ci_checks)),
	rationale TEXT NOT NULL,
	uncertainties TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncertainties)),
	replay_of TEXT REFERENCES verification_runs(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE external_effects (
	id TEXT PRIMARY KEY,
	operation_key TEXT NOT NULL UNIQUE,
	provider TEXT NOT NULL,
	action TEXT NOT NULL,
	intent TEXT NOT NULL CHECK (json_valid(intent)),
	remote_identifier TEXT,
	outcome TEXT CHECK (outcome IS NULL OR json_valid(outcome)),
	reconciliation_state TEXT NOT NULL DEFAULT 'pending' CHECK (reconciliation_state IN ('pending', 'running', 'succeeded', 'failed', 'unknown')),
	claim_owner TEXT,
	lease_expires_at TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE provider_profile_state (
	profile_id TEXT PRIMARY KEY,
	available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
	active_attempts INTEGER NOT NULL DEFAULT 0 CHECK (active_attempts >= 0),
	concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit > 0),
	interactive_reserve INTEGER NOT NULL DEFAULT 0 CHECK (interactive_reserve >= 0),
	cooldown_until TEXT,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE usage_snapshots (
	id TEXT PRIMARY KEY,
	profile_id TEXT NOT NULL REFERENCES provider_profile_state(profile_id) ON DELETE CASCADE,
	quota_window TEXT NOT NULL,
	used INTEGER NOT NULL CHECK (used >= 0),
	remaining INTEGER CHECK (remaining IS NULL OR remaining >= 0),
	observed_at TEXT NOT NULL,
	metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata))
);

CREATE TABLE source_cursors (
	source TEXT PRIMARY KEY CHECK (source IN ('manual', 'slack', 'linear', 'datadog')),
	cursor TEXT,
	revision TEXT,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE artifacts (
	id TEXT PRIMARY KEY,
	case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
	attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
	kind TEXT NOT NULL,
	path TEXT,
	url TEXT,
	hash TEXT,
	transcript_reference TEXT,
	metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX case_events_case_created ON case_events(case_id, created_at);
CREATE INDEX source_events_case_created ON source_events(case_id, created_at);
CREATE INDEX jobs_queue ON jobs(state, priority DESC, created_at);
CREATE INDEX attempts_job_generation ON attempts(job_id, generation DESC);
CREATE INDEX leases_expiry ON attempt_leases(expires_at);
CREATE INDEX effects_claims ON external_effects(reconciliation_state, lease_expires_at);

CREATE VIRTUAL TABLE case_summaries_fts USING fts5(case_id UNINDEXED, title, summary);
CREATE VIRTUAL TABLE approved_memory_fts USING fts5(memory_id UNINDEXED, finding, outcome, root_cause, evidence_summary);

CREATE TRIGGER case_summaries_fts_insert AFTER INSERT ON cases BEGIN
	INSERT INTO case_summaries_fts(case_id, title, summary) VALUES (new.id, new.title, new.title);
END;
CREATE TRIGGER case_summaries_fts_update AFTER UPDATE OF title ON cases BEGIN
	DELETE FROM case_summaries_fts WHERE case_id = old.id;
	INSERT INTO case_summaries_fts(case_id, title, summary) VALUES (new.id, new.title, new.title);
END;
CREATE TRIGGER case_summaries_fts_delete AFTER DELETE ON cases BEGIN
	DELETE FROM case_summaries_fts WHERE case_id = old.id;
END;
CREATE TRIGGER approved_memory_fts_insert AFTER INSERT ON memory_entries WHEN new.approval_status = 'approved' BEGIN
	INSERT INTO approved_memory_fts(memory_id, finding, outcome, root_cause, evidence_summary)
	VALUES (new.id, new.finding, coalesce(new.outcome, ''), coalesce(new.root_cause, ''), new.evidence_summary);
END;
CREATE TRIGGER approved_memory_fts_update AFTER UPDATE ON memory_entries BEGIN
	DELETE FROM approved_memory_fts WHERE memory_id = old.id;
	INSERT INTO approved_memory_fts(memory_id, finding, outcome, root_cause, evidence_summary)
	SELECT new.id, new.finding, coalesce(new.outcome, ''), coalesce(new.root_cause, ''), new.evidence_summary
	WHERE new.approval_status = 'approved';
END;
CREATE TRIGGER approved_memory_fts_delete AFTER DELETE ON memory_entries BEGIN
	DELETE FROM approved_memory_fts WHERE memory_id = old.id;
END;

CREATE TRIGGER case_events_append_only_update BEFORE UPDATE ON case_events BEGIN
	SELECT RAISE(ABORT, 'case_events is append-only');
END;
CREATE TRIGGER case_events_append_only_delete BEFORE DELETE ON case_events BEGIN
	SELECT RAISE(ABORT, 'case_events is append-only');
END;
CREATE TRIGGER source_events_immutable_update BEFORE UPDATE ON source_events BEGIN
	SELECT RAISE(ABORT, 'source_events is immutable');
END;
CREATE TRIGGER source_events_immutable_delete BEFORE DELETE ON source_events BEGIN
	SELECT RAISE(ABORT, 'source_events is immutable');
END;
