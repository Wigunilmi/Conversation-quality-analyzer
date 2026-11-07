BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS appeals (
    id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
    criterion_id TEXT NOT NULL,
    comment TEXT NOT NULL,
    author TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'upheld', 'changed')),
    created_at TEXT NOT NULL,
    original TEXT NOT NULL,
    decision TEXT,
    FOREIGN KEY (evaluation_id, criterion_id)
        REFERENCES evaluation_results(evaluation_id, criterion_id),
    CHECK ((status = 'open' AND decision IS NULL) OR (status != 'open' AND decision IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_appeal_per_criterion
    ON appeals(evaluation_id, criterion_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS appeals_by_evaluation ON appeals(evaluation_id);

PRAGMA user_version = 3;
COMMIT;
