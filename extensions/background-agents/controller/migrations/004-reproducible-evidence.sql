-- Reproducible evidence manifest and independent replay details.
ALTER TABLE evidence_manifests ADD COLUMN manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json));
ALTER TABLE evidence_manifests ADD COLUMN tool_versions TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tool_versions));
ALTER TABLE verification_runs ADD COLUMN actual_results TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actual_results));
ALTER TABLE verification_runs ADD COLUMN replay_history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(replay_history));
CREATE INDEX verification_runs_manifest_created ON verification_runs(manifest_id, created_at DESC);
