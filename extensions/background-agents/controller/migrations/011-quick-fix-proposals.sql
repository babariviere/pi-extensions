-- Durable bounded quick-fix proposals and their policy decisions.

CREATE TABLE quick_fix_proposals (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
	work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE RESTRICT,
	findings TEXT NOT NULL,
	scope TEXT NOT NULL,
	risks TEXT NOT NULL CHECK (json_valid(risks)),
	verification_plan TEXT NOT NULL CHECK (json_valid(verification_plan)),
	decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'observed', 'needs-human', 'rejected')),
	rollout_mode TEXT NOT NULL CHECK (rollout_mode IN ('observe', 'supervised', 'autonomous-pr')),
	decision_reason TEXT NOT NULL,
	decided_by TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE quick_fix_policy_decisions (
	id TEXT PRIMARY KEY,
	proposal_id TEXT NOT NULL UNIQUE REFERENCES quick_fix_proposals(id) ON DELETE CASCADE,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	mode TEXT NOT NULL CHECK (mode IN ('observe', 'supervised', 'autonomous-pr')),
	decision TEXT NOT NULL CHECK (decision IN ('admitted', 'pending', 'observed', 'needs-human', 'rejected')),
	reason TEXT NOT NULL,
	actor TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX quick_fix_proposals_case_updated ON quick_fix_proposals(case_id, updated_at DESC);
