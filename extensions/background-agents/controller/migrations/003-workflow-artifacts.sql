-- Durable artifacts for investigation, private question analysis, and frozen specification approvals.

CREATE TABLE investigation_reports (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
	evidence TEXT NOT NULL CHECK (json_valid(evidence)),
	related_cases TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_cases)),
	report TEXT NOT NULL CHECK (json_valid(report)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE question_briefs (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
	question TEXT NOT NULL,
	findings TEXT NOT NULL CHECK (json_valid(findings)),
	sources TEXT NOT NULL CHECK (json_valid(sources)),
	confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 100),
	uncertainties TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(uncertainties)),
	limits TEXT NOT NULL CHECK (json_valid(limits)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE specification_feedback (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
	spec_version INTEGER NOT NULL CHECK (spec_version > 0),
	feedback TEXT NOT NULL,
	actor TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE approvals ADD COLUMN material_hash TEXT;
ALTER TABLE approvals ADD COLUMN spec_version INTEGER;
ALTER TABLE approvals ADD COLUMN frozen_permissions TEXT CHECK (frozen_permissions IS NULL OR json_valid(frozen_permissions));
ALTER TABLE approvals ADD COLUMN ordered_work_items TEXT CHECK (ordered_work_items IS NULL OR json_valid(ordered_work_items));

UPDATE approvals
SET material_hash = (SELECT material_hash FROM spec_versions WHERE spec_versions.id = approvals.spec_version_id),
	spec_version = (SELECT version FROM spec_versions WHERE spec_versions.id = approvals.spec_version_id),
	frozen_permissions = permissions,
	ordered_work_items = '[]'
WHERE material_hash IS NULL;

CREATE INDEX investigation_reports_case_created ON investigation_reports(case_id, created_at DESC);
CREATE INDEX question_briefs_case_created ON question_briefs(case_id, created_at DESC);
CREATE INDEX specification_feedback_case_created ON specification_feedback(case_id, created_at DESC);

CREATE TRIGGER spec_versions_immutable_update BEFORE UPDATE ON spec_versions BEGIN
	SELECT RAISE(ABORT, 'spec_versions is immutable');
END;
CREATE TRIGGER spec_versions_immutable_delete BEFORE DELETE ON spec_versions BEGIN
	SELECT RAISE(ABORT, 'spec_versions is immutable');
END;
