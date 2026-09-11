-- Classification scores, rationale, and provenance are immutable once recorded.

CREATE TRIGGER classifications_immutable_update BEFORE UPDATE ON classifications BEGIN
	SELECT RAISE(ABORT, 'classifications are immutable');
END;

CREATE TRIGGER classifications_immutable_delete BEFORE DELETE ON classifications BEGIN
	SELECT RAISE(ABORT, 'classifications are immutable');
END;
