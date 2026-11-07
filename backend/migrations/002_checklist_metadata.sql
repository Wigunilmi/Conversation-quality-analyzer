BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS checklist_state (
    checklist_id TEXT PRIMARY KEY REFERENCES checklists(id),
    active_version INTEGER NOT NULL,
    FOREIGN KEY (checklist_id, active_version)
        REFERENCES checklist_versions(checklist_id, version)
);
CREATE TABLE IF NOT EXISTS checklist_version_metadata (
    checklist_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (checklist_id, version),
    FOREIGN KEY (checklist_id, version)
        REFERENCES checklist_versions(checklist_id, version)
);

INSERT OR IGNORE INTO checklist_state (checklist_id, active_version)
SELECT s.id, COALESCE(
    (SELECT active_version FROM channel_checklists WHERE checklist_id = s.id ORDER BY channel LIMIT 1),
    (SELECT MAX(version) FROM checklist_versions WHERE checklist_id = s.id)
)
FROM checklists s;

-- Existing versions have no recorded creation time; keep it unknown rather than invent one.
INSERT OR IGNORE INTO checklist_version_metadata (checklist_id, version, created_at, note)
SELECT checklist_id, version, NULL, '' FROM checklist_versions;

PRAGMA user_version = 2;
COMMIT;
