ALTER TABLE spec_versions ADD COLUMN decomposition TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(decomposition));
ALTER TABLE spec_versions ADD COLUMN ordered_work_items TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ordered_work_items));
ALTER TABLE work_items ADD COLUMN spec_version_id TEXT REFERENCES spec_versions(id) ON DELETE CASCADE;
ALTER TABLE work_items ADD COLUMN scope TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_criteria));
CREATE INDEX work_items_spec_version_ordinal ON work_items(spec_version_id, ordinal);
