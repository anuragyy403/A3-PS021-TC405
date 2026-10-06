/**
 * DialogRepository — all SQL that touches the `dialogs` table.
 *
 * Uses the sql.js API (pure WebAssembly SQLite).
 * The SQL statements are identical to what better-sqlite3 would use;
 * only the method-call style differs.
 *
 * sql.js API notes:
 *   db.run(sql, params)           — execute, no return value
 *   db.exec(sql)                  — execute multi-statement SQL
 *   stmt.getAsObject(params)      — fetch single row as plain object
 *   stmt.getAsObject() iterate   — use stmt.step() / stmt.getAsObject()
 *   db.prepare(sql).run(params)  — prepared statement run
 *
 * Crash-window note:
 *   The caller must call persistToDisk(db, dbPath) after any mutation to
 *   flush the in-memory state to disk.  Without this flush, a process crash
 *   loses the mutation.  The crash window (side effect before persist) is an
 *   acknowledged limitation documented in KIRO_PROJECT_CONTEXT.md.
 */

import type { Database } from 'sql.js';
import type { DialogRecord, LifecycleState } from '../types/index.js';

/** Row shape returned by sql.js getAsObject for the dialogs table. */
interface DialogRow {
  dialog_id:  string;
  task_id:    string;
  state:      string;
  restored:   number; // 0 | 1  (SQLite has no BOOLEAN)
  created_at: string;
  updated_at: string;
}

/** Map a raw sql.js row to the typed DialogRecord. */
function rowToRecord(row: DialogRow): DialogRecord {
  return {
    dialog_id:  row.dialog_id  as string,
    task_id:    row.task_id    as string,
    state:      row.state      as LifecycleState,
    restored:   (row.restored as unknown as number) === 1,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export class DialogRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Insert a new dialog record.
   * Throws if a dialog with the same dialog_id already exists (UNIQUE).
   */
  create(record: DialogRecord): void {
    this.db.run(
      `INSERT INTO dialogs (dialog_id, task_id, state, restored, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        record.dialog_id,
        record.task_id,
        record.state,
        record.restored ? 1 : 0,
        record.created_at,
        record.updated_at,
      ],
    );
  }

  /**
   * Transition a dialog to a new lifecycle state.
   */
  updateState(
    dialogId:  string,
    newState:  LifecycleState,
    restored:  boolean,
    updatedAt: string,
  ): void {
    this.db.run(
      `UPDATE dialogs
       SET state = ?, restored = ?, updated_at = ?
       WHERE dialog_id = ?`,
      [newState, restored ? 1 : 0, updatedAt, dialogId],
    );
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
       ORDER BY created_at ASC`,
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
      `SELECT * FROM dialogs ORDER BY created_at DESC`,
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
