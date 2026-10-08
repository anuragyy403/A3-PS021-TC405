/**
 * Adapter A — Mock initiating/sending adapter for PS-021.
 *
 * Responsibilities:
 *   - Start new dialogs/tasks
 *   - Create dialogs through Dialog Manager
 *   - Assign request sequence numbers from durable state
 *   - Durably log each outgoing request BEFORE sending it
 *   - Send requests through transport
 *   - Receive responses and mark requests acknowledged
 *   - Support retries with preserved identifiers AND preserved payload
 *   - Recover active dialogs/tasks from durable state on startup
 *
 * Adapter A does NOT:
 *   - Manage dialog lifecycle directly (uses Dialog Manager)
 *   - Perform deduplication (Adapter B's responsibility)
 *   - Create new identifiers on retry (preserves dialog_id, task_id, seq)
 *
 * Durable state (survives restart):
 *   dialogs            — dialog_id, task_id, state, restored
 *   outbound_requests  — (dialog_id, seq), payload, PENDING/ACKED, attempts
 *
 * In-memory state (lost on restart, rebuilt by recover()):
 *   the set of dialogs this instance is actively driving.
 *
 * Crash windows:
 *   - Crash after the PENDING row is written but before/while the transport
 *     call happens: recover() reports the seq as pending and it is retried
 *     with the same (dialog_id, seq, payload).  Safe — Adapter B deduplicates
 *     if it had in fact processed it.
 *   - Adapter B's window (side effect executed, crash before the processed
 *     record is persisted) is NOT closed by this log.  See AdapterB.
 */

import type { Database } from 'sql.js';
import { DialogManager } from '../services/DialogManager.js';
import { OutboundRequestRepository } from '../repositories/OutboundRequestRepository.js';
import { NotFoundError } from '../errors.js';
import type { LifecycleState } from '../types/index.js';
import type { Transport } from './Transport.js';
import type { AdapterRequest, AdapterResponse } from './types.js';

/**
 * Task submitted to Adapter A for processing.
 */
export interface Task {
  task_id: string;
  operations: unknown[];  // Mock business operations
}

/**
 * Dialog tracking information exposed by Adapter A.
 * nextSeq is always derived from durable state.
 */
export interface DialogState {
  dialog_id: string;
  task_id:   string;
  nextSeq:   number;  // Next sequence number to assign
}

/**
 * One dialog rebuilt by recover().
 */
export interface RecoveredDialog {
  dialog_id:   string;
  task_id:     string;
  state:       LifecycleState;
  nextSeq:     number;
  pendingSeqs: number[];  // sent but never acknowledged — retry these
}

export class AdapterA {
  private readonly transport:     Transport;
  private readonly outbound:      OutboundRequestRepository;
  private readonly dialogs = new Map<string, string>();  // dialog_id → task_id
  public readonly dialogManager: DialogManager;  // Exposed for recovery operations

  constructor(db: Database, dbPath: string, transport: Transport) {
    this.dialogManager = new DialogManager(db, dbPath);
    this.outbound      = new OutboundRequestRepository(db, dbPath);
    this.transport     = transport;
  }

  /**
   * Start a new dialog for a task.
   *
   * Creates the dialog through Dialog Manager (state = INITIATED).
   * Generates unique dialog_id.
   *
   * Returns the dialog_id.
   */
  startDialog(taskId: string): string {
    const dialogId = this.generateDialogId();

    this.dialogManager.createDialog(dialogId, taskId);
    this.dialogs.set(dialogId, taskId);

    return dialogId;
  }

  /**
   * Send a new request for a dialog.
   *
   * Assigns seq = (highest durable seq) + 1.
   * Writes the request as PENDING before handing it to the transport.
   * Marks it ACKED when Adapter B answers 'ok' or 'duplicate'.
   *
   * If the transport drops the request or response, the row stays PENDING
   * and the MessageDroppedError propagates to the caller.
   *
   * Throws if this instance is not driving the dialog (call recover()
   * after a restart).
   */
  async sendRequest(dialogId: string, payload: unknown): Promise<AdapterResponse> {
    const taskId = this.requireLocalDialog(dialogId);

    const seq = this.outbound.maxSeq(dialogId) + 1;
    this.outbound.recordPending(dialogId, seq, JSON.stringify(payload ?? null));

    return this.deliver({ dialog_id: dialogId, task_id: taskId, seq, payload });
  }

  /**
   * Retry a previously sent request.
   *
   * Preserves dialog_id, task_id, seq AND payload: the payload is read from
   * the durable send log, so a retry is always the same logical request.
   *
   * Throws NotFoundError if (dialog_id, seq) was never sent.
   */
  async retryRequest(dialogId: string, seq: number): Promise<AdapterResponse> {
    const taskId = this.requireLocalDialog(dialogId);

    const logged = this.outbound.findByKey(dialogId, seq);
    if (logged === null) {
      throw new NotFoundError('Outbound request', `${dialogId}#${seq}`);
    }

    this.outbound.incrementAttempts(dialogId, seq);

    return this.deliver({
      dialog_id: dialogId,
      task_id:   taskId,
      seq,       // ← SAME seq as original request
      payload:   JSON.parse(logged.payload),  // ← SAME payload as original
    });
  }

  /**
   * Rebuild Adapter A's working state from durable storage after a restart.
   *
   * For every active (INITIATED / PROCESSING) dialog:
   *   - start driving it again in this instance
   *   - mark it restored
   *   - derive nextSeq from the send log (never from the caller)
   *   - report requests that were in flight (PENDING) so they can be retried
   *
   * Terminal dialogs are not resumed.
   */
  recover(): RecoveredDialog[] {
    const recovered: RecoveredDialog[] = [];

    for (const dialog of this.dialogManager.getActiveDialogs()) {
      const restored = this.dialogManager.markRestored(dialog.dialog_id);
      this.dialogs.set(restored.dialog_id, restored.task_id);

      recovered.push({
        dialog_id:   restored.dialog_id,
        task_id:     restored.task_id,
        state:       restored.state,
        nextSeq:     this.outbound.maxSeq(restored.dialog_id) + 1,
        pendingSeqs: this.outbound.findPending(restored.dialog_id).map(r => r.seq),
      });
    }

    return recovered;
  }

  /**
   * Get the current state of a dialog driven by this Adapter A instance.
   */
  getDialogState(dialogId: string): DialogState | undefined {
    const taskId = this.dialogs.get(dialogId);
    if (taskId === undefined) return undefined;

    return {
      dialog_id: dialogId,
      task_id:   taskId,
      nextSeq:   this.outbound.maxSeq(dialogId) + 1,
    };
  }

  /**
   * Get all dialog states driven by this instance (for testing/recovery).
   */
  getAllDialogStates(): Map<string, DialogState> {
    const states = new Map<string, DialogState>();
    for (const dialogId of this.dialogs.keys()) {
      states.set(dialogId, this.getDialogState(dialogId)!);
    }
    return states;
  }

  /**
   * Send through the transport and acknowledge on a definitive answer.
   * 'error' responses and dropped messages leave the request PENDING.
   */
  private async deliver(request: AdapterRequest): Promise<AdapterResponse> {
    const response = await this.transport.sendRequest(request);

    if (response.status === 'ok' || response.status === 'duplicate') {
      this.outbound.markAcked(request.dialog_id, request.seq);
    }

    return response;
  }

  private requireLocalDialog(dialogId: string): string {
    const taskId = this.dialogs.get(dialogId);
    if (taskId === undefined) {
      throw new Error(`Dialog not found in Adapter A: ${dialogId}`);
    }
    return taskId;
  }

  /**
   * Generate a unique dialog_id.
   *
   * In production, this would use a proper ID generation strategy.
   * For testing, we use a simple timestamp-based approach.
   */
  private generateDialogId(): string {
    return `dlg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
