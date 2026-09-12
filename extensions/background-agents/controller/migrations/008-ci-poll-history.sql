ALTER TABLE verification_runs ADD COLUMN ci_history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ci_history));
