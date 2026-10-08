-- PS-021 Nighthawks — authoritative SQLite schema.
--
-- Two tables are the minimum required by the approved architecture:
--
--   dialogs  — dialog identity, lifecycle state, timestamps
--   requests — processed-request ledger (deduplication source of truth)
--
-- The deduplication key is (dialog_id, seq).  Two different dialogs can
-- use identical sequence numbers without collision because dialog_id is
-- part of every uniqueness constraint.
--
-- NOTE: WAITING_ACK is intentionally absent from the CHECK constraint.
--       It is a frontend-only presentation state and must not enter the
--       backend schema.

PRAGMA journal_mode = WAL;   -- Write-Ahead Log: concurrent readers during writes
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- dialogs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dialogs (
  dialog_id  TEXT    NOT NULL PRIMARY KEY,
  task_id    TEXT    NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'INITIATED'
               CHECK (state IN ('INITIATED','PROCESSING','COMMITTED','RECOVERED','FAILED')),
  restored   INTEGER NOT NULL DEFAULT 0   -- 0 = false, 1 = true (SQLite has no BOOLEAN)
               CHECK (restored IN (0, 1))
);

-- ---------------------------------------------------------------------------
-- requests  (processed-request ledger — deduplication source of truth)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  dialog_id    TEXT    NOT NULL REFERENCES dialogs(dialog_id),
  seq          INTEGER NOT NULL CHECK (seq > 0),
  processed_at TEXT    NOT NULL,          -- ISO 8601
  result       TEXT    NOT NULL,          -- JSON string; returned on duplicate
  --
  -- The composite primary key IS the deduplication key.
  -- Inserting the same (dialog_id, seq) a second time raises UNIQUE violation.
  PRIMARY KEY (dialog_id, seq)
);

-- Fast lookup of all active (non-terminal) dialogs for recovery on startup.
CREATE INDEX IF NOT EXISTS idx_dialogs_active
  ON dialogs (state)
  WHERE state IN ('INITIATED', 'PROCESSING');
