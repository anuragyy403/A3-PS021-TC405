-- PS-021 Nighthawks — authoritative SQLite schema.
--
-- Three tables:
--
--   dialogs           — dialog identity (dialog_id, task_id), lifecycle state,
--                       restored flag
--   requests          — Adapter B's processed-request ledger
--                       (deduplication source of truth)
--   outbound_requests — Adapter A's durable send log (PENDING / ACKED,
--                       payload, attempts)
--
-- Experimental schema — see docs/EXPERIMENTAL_SCHEMA.md.  Not a standard,
-- not MCP, not A2A.
--
-- The deduplication key is (dialog_id, seq).  Two different dialogs can
-- use identical sequence numbers without collision because dialog_id is
-- part of every uniqueness constraint.
--
-- NOTE: WAITING_ACK is intentionally absent from the CHECK constraint.
--       It is a frontend-only presentation state and must not enter the
--       backend schema.

-- No journal_mode pragma: sql.js runs SQLite in memory and the whole database
-- is written to the file by persistToDisk() after every mutation, so SQLite's
-- own journaling plays no part in durability here.
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

-- ---------------------------------------------------------------------------
-- outbound_requests  (Adapter A's durable send log)
-- ---------------------------------------------------------------------------
-- Adapter A writes a request here as PENDING *before* handing it to the
-- transport, and marks it ACKED once Adapter B answers ('ok' or 'duplicate').
--
-- On restart Adapter A rebuilds from this table:
--   next seq      = MAX(seq) + 1 per dialog
--   in-flight     = rows still PENDING (retried with the SAME seq + payload)
--
-- The stored payload makes a retry the same logical request: the caller
-- cannot change the payload under an existing (dialog_id, seq).
CREATE TABLE IF NOT EXISTS outbound_requests (
  dialog_id  TEXT    NOT NULL REFERENCES dialogs(dialog_id),
  seq        INTEGER NOT NULL CHECK (seq > 0),
  payload    TEXT    NOT NULL,          -- JSON string
  status     TEXT    NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING', 'ACKED')),
  attempts   INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  PRIMARY KEY (dialog_id, seq)
);
