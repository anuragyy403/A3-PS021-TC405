/**
 * Adapter B — Mock receiving/processing adapter for PS-021.
 *
 * Responsibilities:
 *   - Receive requests from Adapter A
 *   - Correlate requests to existing dialogs (via Dialog Manager)
 *   - Verify task identity
 *   - Check for duplicate requests (via Request Repository)
 *   - Process requests (mock side effect)
 *   - Record processed requests (durable deduplication)
 *   - Return responses
 *   - Transition dialog lifecycle states (INITIATED → PROCESSING only)
 *   - Reject new work for terminal dialogs (idempotent replay still allowed)
 *
 * Adapter B does NOT:
 *   - Create its own lifecycle state machine (uses Dialog Manager)
 *   - Maintain in-memory deduplication (uses durable Request Repository)
 *   - Re-execute side effects for duplicate requests
 *   - Decide when a task is complete (Adapter A owns completion / failure)
 */

import type { Database } from 'sql.js';
import { DialogManager } from '../services/DialogManager.js';
import { RequestRepository } from '../repositories/RequestRepository.js';
import type { Transport } from './Transport.js';
import type { AdapterErrorCode, AdapterRequest, AdapterResponse } from './types.js';
import { isTerminal } from '../types/index.js';
import { NotFoundError, TaskMismatchError, DialogTerminalError } from '../errors.js';

/** Map an error raised while handling a request to its response error_code. */
function errorCodeFor(error: unknown): AdapterErrorCode {
  if (error instanceof NotFoundError)       return 'DIALOG_NOT_FOUND';
  if (error instanceof TaskMismatchError)   return 'TASK_MISMATCH';
  if (error instanceof DialogTerminalError) return 'DIALOG_TERMINAL';
  return 'INTERNAL';
}

/**
 * Mock side effect counter for testing duplicate-side-effect prevention.
 *
 * This is the observable behavior that proves deduplication works.
 * Each dialog tracks how many times its operations were actually executed.
 */
export interface SideEffectTracker {
  getProcessCount(dialogId: string): number;
  increment(dialogId: string): void;
  reset(): void;
}

/**
 * Default in-memory side effect tracker for testing.
 */
export class InMemorySideEffectTracker implements SideEffectTracker {
  private counts = new Map<string, number>();

  getProcessCount(dialogId: string): number {
    return this.counts.get(dialogId) ?? 0;
  }

  increment(dialogId: string): void {
    const current = this.counts.get(dialogId) ?? 0;
    this.counts.set(dialogId, current + 1);
  }

  reset(): void {
    this.counts.clear();
  }
}

export class AdapterB {
  private readonly dialogManager: DialogManager;
  private readonly requestRepo:   RequestRepository;
  private readonly transport:     Transport;
  private readonly sideEffects:   SideEffectTracker;

  constructor(
    db: Database,
    dbPath: string,
    transport: Transport,
    sideEffects: SideEffectTracker = new InMemorySideEffectTracker(),
  ) {
    this.dialogManager = new DialogManager(db, dbPath);
    this.requestRepo   = new RequestRepository(db, dbPath);
    this.transport     = transport;
    this.sideEffects   = sideEffects;

    // Register as the request handler
    this.transport.registerRequestHandler(this.handleRequest.bind(this));
  }

  /**
   * Handle an incoming request from Adapter A.
   *
   * Flow (order matters):
   *   1. Correlate to existing dialog and verify task identity (Dialog Manager)
   *   2. If (dialog_id, seq) was already processed: return the stored result
   *      as 'duplicate' — even when the dialog is terminal (idempotent replay)
   *   3. If the dialog is terminal: reject with DIALOG_TERMINAL — no side
   *      effect, no processed record, no transition
   *   4. Otherwise: execute mock side effect, record request, return result
   *   5. First processed request moves INITIATED → PROCESSING
   */
  private async handleRequest(request: AdapterRequest): Promise<AdapterResponse> {
    try {
      // Step 1: Correlate and verify task identity
      const dialog = this.dialogManager.correlate(request.dialog_id, request.task_id);

      // Step 2: Check for duplicate
      const existing = this.requestRepo.findByKey(request.dialog_id, request.seq);

      if (existing !== null) {
        // Duplicate detected — return stored result, do NOT re-execute
        return {
          dialog_id: request.dialog_id,
          task_id:   request.task_id,
          seq:       request.seq,
          status:    'duplicate',
          result:    JSON.parse(existing.result),
        };
      }

      // Step 3: A finished dialog accepts no new work
      if (isTerminal(dialog.state)) {
        throw new DialogTerminalError(dialog.dialog_id, dialog.state);
      }

      // Step 4: New request — execute mock side effect
      //
      // Crash window: the side effect runs BEFORE the processed record below
      // is persisted.  A crash between the two means a retry will execute the
      // side effect again.  This is a known, documented limitation — the
      // guarantee is duplicate-side-effect prevention only once the original
      // request has been durably recorded as processed, not exactly-once.
      const result = this.executeMockSideEffect(request.dialog_id, request.payload);

      // Record request as processed (durable deduplication)
      const recorded = this.requestRepo.record({
        dialog_id:    request.dialog_id,
        seq:          request.seq,
        processed_at: new Date().toISOString(),
        result:       JSON.stringify(result),
      });

      if (!recorded) {
        // Race condition: another process recorded this between our check and insert
        // Treat as duplicate
        const storedResult = this.requestRepo.findByKey(request.dialog_id, request.seq);
        return {
          dialog_id: request.dialog_id,
          task_id:   request.task_id,
          seq:       request.seq,
          status:    'duplicate',
          result:    JSON.parse(storedResult!.result),
        };
      }

      // Step 5: Transition dialog state
      // First request: INITIATED → PROCESSING
      if (dialog.state === 'INITIATED') {
        this.dialogManager.transition(request.dialog_id, 'PROCESSING');
      }

      // Return success response
      return {
        dialog_id: request.dialog_id,
        task_id:   request.task_id,
        seq:       request.seq,
        status:    'ok',
        result,
      };

    } catch (error) {
      // Dialog not found, task identity mismatch, terminal dialog, etc.
      return {
        dialog_id:  request.dialog_id,
        task_id:    request.task_id,
        seq:        request.seq,
        status:     'error',
        result:     null,
        error:      error instanceof Error ? error.message : String(error),
        error_code: errorCodeFor(error),
      };
    }
  }

  /**
   * Execute the mock side effect.
   *
   * This is a deterministic operation for testing.
   * The critical behavior: this is called ONCE per unique (dialog_id, seq).
   * Duplicates do NOT trigger this.
   *
   * Returns a mock result that can be stored and returned on duplicate.
   */
  private executeMockSideEffect(dialogId: string, payload: unknown): unknown {
    // Increment the side effect counter (observable for testing)
    this.sideEffects.increment(dialogId);

    // Return a deterministic result
    return {
      processed: true,
      payload,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get the side effect tracker (for testing).
   */
  getSideEffectTracker(): SideEffectTracker {
    return this.sideEffects;
  }

  /**
   * Get the dialog manager (for testing).
   */
  getDialogManager(): DialogManager {
    return this.dialogManager;
  }
}
