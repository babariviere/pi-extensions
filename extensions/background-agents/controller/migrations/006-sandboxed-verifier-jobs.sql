-- Bind verifier generations to the immutable manifest and exact commits they must replay.
ALTER TABLE jobs ADD COLUMN manifest_id TEXT REFERENCES evidence_manifests(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN expected_base_sha TEXT;
ALTER TABLE jobs ADD COLUMN expected_candidate_sha TEXT;
ALTER TABLE verification_runs ADD COLUMN result_version INTEGER NOT NULL DEFAULT 1;

