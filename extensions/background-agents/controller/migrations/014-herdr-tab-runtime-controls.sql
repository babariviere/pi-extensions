-- Persist Herdr tab ownership separately from the root pane used to launch a service.

ALTER TABLE attempts ADD COLUMN tab_id TEXT;
ALTER TABLE usage_stop_intents ADD COLUMN tab_id TEXT;
ALTER TABLE usage_stop_intents ADD COLUMN tab_confirmed INTEGER NOT NULL DEFAULT 1 CHECK (tab_confirmed IN (0, 1));
ALTER TABLE emergency_stop_attempts ADD COLUMN tab_id TEXT;
ALTER TABLE emergency_stop_attempts ADD COLUMN tab_confirmed INTEGER NOT NULL DEFAULT 1 CHECK (tab_confirmed IN (0, 1));

UPDATE usage_stop_intents
SET tab_id = (SELECT tab_id FROM attempts WHERE attempts.id = usage_stop_intents.attempt_id),
	tab_confirmed = CASE WHEN (SELECT tab_id FROM attempts WHERE attempts.id = usage_stop_intents.attempt_id) IS NULL THEN 1 ELSE 0 END;

UPDATE emergency_stop_attempts
SET tab_id = (SELECT tab_id FROM attempts WHERE attempts.id = emergency_stop_attempts.attempt_id),
	tab_confirmed = CASE WHEN (SELECT tab_id FROM attempts WHERE attempts.id = emergency_stop_attempts.attempt_id) IS NULL THEN 1 ELSE 0 END;
