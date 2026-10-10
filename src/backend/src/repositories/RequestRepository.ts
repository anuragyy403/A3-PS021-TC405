/**
 * RequestRepository — all SQL that touches the `requests` table.
 *
 * Uses the sql.js API (pure WebAssembly SQLite).
 *
 * Deduplication key: (dialog_id, seq)
 *
 * record() returns true if newly inserted, false if (dialog_id, seq) already exists.
 *
 * Persistence:
 *   Every mutation method calls persistToDisk() before returning to ensure
 *   the change is flushed to the SQLite file.  This guarantees durability
 *   across process restarts (deduplication records survive restart).
 */

import type { Database } from 'sql.js';
import type { RequestRecord } from '../types/index.js';
import { persistToDisk } from '../db/index.js';

type RawRow = Record<string, unknown>;

export class RequestRepository {
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
   * Record that a request has been processed.
   *
   * Returns true  → newly inserted (first time this (dialog_id, seq) was seen)
   * Returns false → already existed (duplicate — do not re-execute side effect)
   *
   * NOTE: Check-then-insert is safe in single-threaded Node.js.
   * Flushes to disk before returning.
   */
  record(entry: RequestRecord): boolean {
    const existing = this.findByKey(entry.dialog_id, entry.seq);
    if (existing !== null) {
      return false;
    }

    this.db.run(
      `INSERT OR IGNORE INTO requests (dialog_id, seq, processed_at, result)
       VALUES (?, ?, ?, ?)`,
      [entry.dialog_id, entry.seq, entry.processed_at, entry.result],
    );

    persistToDisk(this.db, this.dbPath);
    return true;
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Look up a single request record by its deduplication key (dialog_id, seq).
   * Returns null when no matching record exists.
   */
  findByKey(dialogId: string, seq: number): RequestRecord | null {
    const stmt = this.db.prepare(
      `SELECT * FROM requests WHERE dialog_id = ? AND seq = ?`,
    );
    stmt.bind([dialogId, seq]);
    const hasRow = stmt.step();
    if (!hasRow) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as unknown as RawRow;
    stmt.free();
    return {
      dialog_id:    row['dialog_id'] as string,
      seq:          Number(row['seq']),
      processed_at: row['processed_at'] as string,
      result:       row['result'] as string,
    };
  }

  /**
   * Return all processed requests for a given dialog, in sequence order.
   */
  findByDialog(dialogId: string): RequestRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM requests WHERE dialog_id = ? ORDER BY seq ASC`,
    );
    stmt.bind([dialogId]);
    const rows: RequestRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as RawRow;
      rows.push({
        dialog_id:    row['dialog_id'] as string,
        seq:          Number(row['seq']),
        processed_at: row['processed_at'] as string,
        result:       row['result'] as string,
      });
    }
    stmt.free();
    return rows;
  }

  /**
   * Return count of processed requests per dialog.
   */
  countPerDialog(): Map<string, number> {
    const stmt = this.db.prepare(
      `SELECT dialog_id, COUNT(*) as n FROM requests GROUP BY dialog_id`,
    );
    const result = new Map<string, number>();
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as RawRow;
      result.set(row['dialog_id'] as string, Number(row['n']));
    }
    stmt.free();
    return result;
  }

  /**
   * Total number of request records across all dialogs.
   */
  totalCount(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as n FROM requests`);
    stmt.step();
    const row = stmt.getAsObject() as unknown as RawRow;
    stmt.free();
    return Number(row['n']);
  }
}
