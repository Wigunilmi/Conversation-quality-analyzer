BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist_versions (
    checklist_id TEXT NOT NULL REFERENCES checklists(id),
    version INTEGER NOT NULL CHECK (version > 0),
    checklist TEXT NOT NULL,
    PRIMARY KEY (checklist_id, version)
);
CREATE TABLE IF NOT EXISTS channel_checklists (
    channel TEXT PRIMARY KEY,
    checklist_id TEXT NOT NULL,
    active_version INTEGER NOT NULL,
    FOREIGN KEY (checklist_id, active_version)
        REFERENCES checklist_versions(checklist_id, version)
);
CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    checklist_id TEXT NOT NULL,
    checklist_version INTEGER NOT NULL,
    metadata TEXT NOT NULL,
    FOREIGN KEY (checklist_id, checklist_version)
        REFERENCES checklist_versions(checklist_id, version)
);
CREATE TABLE IF NOT EXISTS evaluation_results (
    evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
    criterion_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (evaluation_id, criterion_id),
    UNIQUE (evaluation_id, position)
);

PRAGMA user_version = 1;
COMMIT;
