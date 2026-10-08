/**
 * Adapter A — Mock initiating/sending adapter for PS-021.
 *
 * Responsibilities:
 *   - Start new dialogs/tasks
 *   - Create dialogs through Dialog Manager
 *   - Generate request sequence numbers
 *   - Build outgoing requests
 *   - Send requests through transport
 *   - Receive responses
 *   - Support retries with preserved identifiers
 *
 * Adapter A does NOT:
 *   - Manage dialog lifecycle directly (uses Dialog Manager)
 *   - Perform deduplication (Adapter B's responsibility)
 *   - Create new identifiers on retry (preserves dialog_id, task_id, seq)
 */

import type { Database } from 'sql.js';
import { DialogManager } from '../services/DialogManager.js';
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
 * Dialog tracking information maintained by Adapter A.
 */
interface DialogState {
  dialog_id: string;
  task_id:   string;
  nextSeq:   number;  // Next sequence number to assign
}

export class AdapterA {
  private readonly transport:     Transport;
  private readonly dialogs = new Map<string, DialogState>();  // dialog_id → state
  public readonly dialogManager: DialogManager;  // Exposed for recovery operations

  constructor(db: Database, dbPath: string, transport: Transport) {
    this.dialogManager = new DialogManager(db, dbPath);
    this.transport     = transport;
  }

  /**
   * Start a new dialog for a task.
   *
   * Creates the dialog through Dialog Manager.
   * Generates unique dialog_id.
   * Initializes sequence tracking.
   *
   * Returns the dialog_id.
   */
  startDialog(taskId: string): string {
    // Generate unique dialog_id
    const dialogId = this.generateDialogId();

    // Create dialog through Dialog Manager (state = INITIATED)
    this.dialogManager.createDialog(dialogId, taskId);

    // Track dialog state locally
    this.dialogs.set(dialogId, {
      dialog_id: dialogId,
      task_id:   taskId,
      nextSeq:   1,  // First request will be seq=1
    });

    return dialogId;
  }

  /**
   * Send a request for a dialog.
   *
   * Generates the next sequence number.
   * Builds the request.
   * Sends through transport.
   * Returns the response.
   *
   * Throws if dialog does not exist locally.
   */
  async sendRequest(dialogId: string, payload: unknown): Promise<AdapterResponse> {
    const dialogState = this.dialogs.get(dialogId);
    if (!dialogState) {
      throw new Error(`Dialog not found in Adapter A: ${dialogId}`);
    }

    // Generate sequence number
    const seq = dialogState.nextSeq;
    dialogState.nextSeq += 1;

    // Build request
    const request: AdapterRequest = {
      dialog_id: dialogState.dialog_id,
      task_id:   dialogState.task_id,
      seq,
      payload,
    };

    // Send through transport
    const response = await this.transport.sendRequest(request);

    return response;
  }

  /**
   * Retry a request with the same sequence number.
   *
   * Preserves dialog_id, task_id, and seq.
   * This is the critical retry behavior: same logical request keeps same seq.
   *
   * Throws if dialog does not exist locally.
   */
  async retryRequest(dialogId: string, seq: number, payload: unknown): Promise<AdapterResponse> {
    const dialogState = this.dialogs.get(dialogId);
    if (!dialogState) {
      throw new Error(`Dialog not found in Adapter A: ${dialogId}`);
    }

    // Build request with SAME seq (retry)
    const request: AdapterRequest = {
      dialog_id: dialogState.dialog_id,
      task_id:   dialogState.task_id,
      seq,       // ← SAME seq as original request
      payload,
    };

    // Send through transport
    const response = await this.transport.sendRequest(request);

    return response;
  }

  /**
   * Get the current state of a dialog tracked by Adapter A.
   */
  getDialogState(dialogId: string): DialogState | undefined {
    return this.dialogs.get(dialogId);
  }

  /**
   * Reload dialog state for recovery.
   *
   * Used when Adapter A restarts and needs to resume an existing dialog.
   * The dialog must already exist in durable storage (Dialog Manager).
   *
   * This simulates Adapter A recovering its state after a restart.
   */
  reloadDialog(dialogId: string, taskId: string, nextSeq: number): void {
    // Verify dialog exists in Dialog Manager
    const dialog = this.dialogManager.getDialog(dialogId);
    if (!dialog) {
      throw new Error(`Cannot reload non-existent dialog: ${dialogId}`);
    }

    // Verify task identity matches
    if (dialog.task_id !== taskId) {
      throw new Error(`Task ID mismatch: expected ${taskId}, got ${dialog.task_id}`);
    }

    // Restore local state
    this.dialogs.set(dialogId, {
      dialog_id: dialogId,
      task_id:   taskId,
      nextSeq,
    });
  }

  /**
   * Get all tracked dialog states (for testing/recovery).
   */
  getAllDialogStates(): Map<string, DialogState> {
    return new Map(this.dialogs);
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
