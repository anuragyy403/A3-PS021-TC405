/**
 * DialogRepository — all SQL that touches the `dialogs` table.
 *
 * Uses the sql.js API (pure WebAssembly SQLite).
 * The SQL is plain SQLite; only the sql.js method-call style is driver-specific.
 *
 * sql.js API notes:
 *   db.run(sql, params)           — execute, no return value
 *   db.exec(sql)                  — execute multi-statement SQL
 *   stmt.getAsObject(params)      — fetch single row as plain object
 *   stmt.getAsObject() iterate   — use stmt.step() / stmt.getAsObject()
 *   db.prepare(sql).run(params)  — prepared statement run
 *
 * Persistence:
 *   Every mutation method calls persistToDisk() before returning to ensure
 *   the change is flushed to the SQLite file.  This guarantees durability
 *   across process restarts (R3 requirement).
 *
 * Crash-window note:
 *   The crash window (side effect before persist) is an acknowledged
 *   limitation documented in README.md and docs/EXPERIMENTAL_SCHEMA.md.  This implementation
 *   minimizes that window by persisting immediately after the SQL mutation.
 */

import type { Database } from 'sql.js';
import type { DialogRecord, LifecycleState } from '../types/index.js';
import { persistToDisk } from '../db/index.js';

/** Row shape returned by sql.js getAsObject for the dialogs table. */
interface DialogRow {
  dialog_id:  string;
  task_id:    string;
  state:      string;
  restored:   number; // 0 | 1  (SQLite has no BOOLEAN)
}

/** Map a raw sql.js row to the typed DialogRecord. */
function rowToRecord(row: DialogRow): DialogRecord {
  return {
    dialog_id:  row.dialog_id  as string,
    task_id:    row.task_id    as string,
    state:      row.state      as LifecycleState,
    restored:   (row.restored as unknown as number) === 1,
  };
}

export class DialogRepository {
  private readonly db: Database;
  private readonly dbPath: string;

  constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Insert a new dialog record.
   * Throws if a dialog with the same dialog_id already exists (UNIQUE).
   * Flushes to disk before returning.
   */
  create(record: DialogRecord): void {
    this.db.run(
      `INSERT INTO dialogs (dialog_id, task_id, state, restored)
       VALUES (?, ?, ?, ?)`,
      [
        record.dialog_id,
        record.task_id,
        record.state,
        record.restored ? 1 : 0,
      ],
    );
    persistToDisk(this.db, this.dbPath);
  }

  /**
   * Transition a dialog to a new lifecycle state.
   * Flushes to disk before returning.
   */
  updateState(
    dialogId:  string,
    newState:  LifecycleState,
    restored:  boolean,
  ): void {
    this.db.run(
      `UPDATE dialogs
       SET state = ?, restored = ?
       WHERE dialog_id = ?`,
      [newState, restored ? 1 : 0, dialogId],
    );
    persistToDisk(this.db, this.dbPath);
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Retrieve a single dialog by its ID.
   * Returns null when no matching dialog exists.
   */
  findById(dialogId: string): DialogRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM dialogs WHERE dialog_id = ?`);
    stmt.bind([dialogId]);
    const hasRow = stmt.step();
    if (!hasRow) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as unknown as DialogRow;
    stmt.free();
    return rowToRecord(row);
  }

  /**
   * Return all dialogs currently in a non-terminal state.
   * Used by the recovery path on startup.
   */
  findActive(): DialogRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM dialogs
       WHERE state IN ('INITIATED', 'PROCESSING')
       ORDER BY dialog_id ASC`,
    );
    const rows: DialogRecord[] = [];
    while (stmt.step()) {
      rows.push(rowToRecord(stmt.getAsObject() as unknown as DialogRow));
    }
    stmt.free();
    return rows;
  }

  /**
   * Return every dialog.
   */
  findAll(): DialogRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM dialogs ORDER BY dialog_id ASC`,
    );
    const rows: DialogRecord[] = [];
    while (stmt.step()) {
      rows.push(rowToRecord(stmt.getAsObject() as unknown as DialogRow));
    }
    stmt.free();
    return rows;
  }

  /**
   * Return the count of dialogs per state.
   */
  countByState(): Record<string, number> {
    const stmt = this.db.prepare(
      `SELECT state, COUNT(*) as n FROM dialogs GROUP BY state`,
    );
    const result: Record<string, number> = {};
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as { state: string; n: number };
      result[row.state] = Number(row.n);
    }
    stmt.free();
    return result;
  }
}
