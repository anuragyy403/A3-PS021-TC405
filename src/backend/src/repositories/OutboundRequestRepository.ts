/**
 * OutboundRequestRepository — all SQL that touches the `outbound_requests` table.
 *
 * This is Adapter A's durable send log.  It is the source of truth for:
 *   - the next sequence number of a dialog (MAX(seq) + 1)
 *   - which requests were in flight when Adapter A stopped (status = PENDING)
 *   - the exact payload of a logical request, replayed on retry
 *
 * Key: (dialog_id, seq) — the same logical-request key Adapter B uses for
 * deduplication.
 *
 * Persistence:
 *   Every mutation method calls persistToDisk() before returning, so a
 *   PENDING row is on disk before the request is handed to the transport.
 */

import type { Database } from 'sql.js';
import type { OutboundRequestRecord, OutboundStatus } from '../types/index.js';
import { persistToDisk } from '../db/index.js';

type RawRow = Record<string, unknown>;

function rowToRecord(row: RawRow): OutboundRequestRecord {
  return {
    dialog_id: row['dialog_id'] as string,
    seq:       Number(row['seq']),
    payload:   row['payload'] as string,
    status:    row['status'] as OutboundStatus,
    attempts:  Number(row['attempts']),
  };
}

export class OutboundRequestRepository {
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
   * Record a new outbound request as PENDING with attempts = 1.
   * Throws if (dialog_id, seq) already exists (PRIMARY KEY).
   * Flushes to disk before returning.
   */
  recordPending(dialogId: string, seq: number, payload: string): void {
    this.db.run(
      `INSERT INTO outbound_requests (dialog_id, seq, payload, status, attempts)
       VALUES (?, ?, ?, 'PENDING', 1)`,
      [dialogId, seq, payload],
    );
    persistToDisk(this.db, this.dbPath);
  }

  /**
   * Mark a request as acknowledged by Adapter B.
   * Flushes to disk before returning.
   */
  markAcked(dialogId: string, seq: number): void {
    this.db.run(
      `UPDATE outbound_requests SET status = 'ACKED'
       WHERE dialog_id = ? AND seq = ?`,
      [dialogId, seq],
    );
    persistToDisk(this.db, this.dbPath);
  }

  /**
   * Count one more transport attempt for a request (used on retry).
   * Flushes to disk before returning.
   */
  incrementAttempts(dialogId: string, seq: number): void {
    this.db.run(
      `UPDATE outbound_requests SET attempts = attempts + 1
       WHERE dialog_id = ? AND seq = ?`,
      [dialogId, seq],
    );
    persistToDisk(this.db, this.dbPath);
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Look up one outbound request by (dialog_id, seq).
   * Returns null when no matching record exists.
   */
  findByKey(dialogId: string, seq: number): OutboundRequestRecord | null {
    const stmt = this.db.prepare(
      `SELECT * FROM outbound_requests WHERE dialog_id = ? AND seq = ?`,
    );
    stmt.bind([dialogId, seq]);
    const hasRow = stmt.step();
    if (!hasRow) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as unknown as RawRow;
    stmt.free();
    return rowToRecord(row);
  }

  /**
   * Return all PENDING (unacknowledged) requests for a dialog, in seq order.
   */
  findPending(dialogId: string): OutboundRequestRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM outbound_requests
       WHERE dialog_id = ? AND status = 'PENDING'
       ORDER BY seq ASC`,
    );
    stmt.bind([dialogId]);
    const rows: OutboundRequestRecord[] = [];
    while (stmt.step()) {
      rows.push(rowToRecord(stmt.getAsObject() as unknown as RawRow));
    }
    stmt.free();
    return rows;
  }

  /**
   * Return every outbound request (PENDING and ACKED) for a dialog, in seq order.
   */
  findByDialog(dialogId: string): OutboundRequestRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM outbound_requests WHERE dialog_id = ? ORDER BY seq ASC`,
    );
    stmt.bind([dialogId]);
    const rows: OutboundRequestRecord[] = [];
    while (stmt.step()) {
      rows.push(rowToRecord(stmt.getAsObject() as unknown as RawRow));
    }
    stmt.free();
    return rows;
  }

  /**
   * Total transport attempts (SUM of attempts) for one dialog, or across all
   * dialogs when dialogId is omitted.  0 when there are no rows.
   */
  sumAttempts(dialogId?: string): number {
    const stmt = dialogId === undefined
      ? this.db.prepare(`SELECT COALESCE(SUM(attempts), 0) AS n FROM outbound_requests`)
      : this.db.prepare(
          `SELECT COALESCE(SUM(attempts), 0) AS n FROM outbound_requests WHERE dialog_id = ?`,
        );
    if (dialogId !== undefined) stmt.bind([dialogId]);
    stmt.step();
    const row = stmt.getAsObject() as unknown as RawRow;
    stmt.free();
    return Number(row['n']);
  }

  /**
   * Highest seq ever assigned in a dialog, or 0 if none.
   */
  maxSeq(dialogId: string): number {
    const stmt = this.db.prepare(
      `SELECT MAX(seq) AS m FROM outbound_requests WHERE dialog_id = ?`,
    );
    stmt.bind([dialogId]);
    stmt.step();
    const row = stmt.getAsObject() as unknown as RawRow;
    stmt.free();
    return row['m'] == null ? 0 : Number(row['m']);
  }
}
