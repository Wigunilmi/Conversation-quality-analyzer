CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, payload TEXT NOT NULL,
    rowid BIGSERIAL NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS checklists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, rowid BIGSERIAL NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS checklist_versions (
    checklist_id TEXT NOT NULL REFERENCES checklists(id),
    version INTEGER NOT NULL CHECK (version > 0), checklist TEXT NOT NULL,
    PRIMARY KEY (checklist_id, version)
);
CREATE TABLE IF NOT EXISTS channel_checklists (
    channel TEXT PRIMARY KEY, checklist_id TEXT NOT NULL, active_version INTEGER NOT NULL,
    rowid BIGSERIAL NOT NULL UNIQUE,
    FOREIGN KEY (checklist_id, active_version) REFERENCES checklist_versions(checklist_id, version)
);
CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    checklist_id TEXT NOT NULL, checklist_version INTEGER NOT NULL, metadata TEXT NOT NULL,
    rowid BIGSERIAL NOT NULL UNIQUE,
    FOREIGN KEY (checklist_id, checklist_version) REFERENCES checklist_versions(checklist_id, version)
);
CREATE INDEX IF NOT EXISTS evaluations_by_conversation ON evaluations(conversation_id, rowid);
CREATE TABLE IF NOT EXISTS evaluation_results (
    evaluation_id TEXT NOT NULL REFERENCES evaluations(id), criterion_id TEXT NOT NULL,
    position INTEGER NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY (evaluation_id, criterion_id), UNIQUE (evaluation_id, position)
);
CREATE TABLE IF NOT EXISTS checklist_state (
    checklist_id TEXT PRIMARY KEY REFERENCES checklists(id), active_version INTEGER NOT NULL,
    FOREIGN KEY (checklist_id, active_version) REFERENCES checklist_versions(checklist_id, version)
);
CREATE TABLE IF NOT EXISTS checklist_version_metadata (
    checklist_id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT, note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (checklist_id, version),
    FOREIGN KEY (checklist_id, version) REFERENCES checklist_versions(checklist_id, version)
);
CREATE TABLE IF NOT EXISTS appeals (
    id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
    criterion_id TEXT NOT NULL, comment TEXT NOT NULL, author TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'upheld', 'changed')),
    created_at TEXT NOT NULL, original TEXT NOT NULL, decision TEXT,
    rowid BIGSERIAL NOT NULL UNIQUE,
    FOREIGN KEY (evaluation_id, criterion_id) REFERENCES evaluation_results(evaluation_id, criterion_id),
    CHECK ((status = 'open' AND decision IS NULL) OR (status != 'open' AND decision IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_appeal_per_criterion
    ON appeals(evaluation_id, criterion_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS appeals_by_evaluation ON appeals(evaluation_id);
