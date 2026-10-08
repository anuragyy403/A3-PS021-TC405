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
 *   - Transition dialog lifecycle states
 *
 * Adapter B does NOT:
 *   - Create its own lifecycle state machine (uses Dialog Manager)
 *   - Maintain in-memory deduplication (uses durable Request Repository)
 *   - Re-execute side effects for duplicate requests
 */

import type { Database } from 'sql.js';
import { DialogManager } from '../services/DialogManager.js';
import { RequestRepository } from '../repositories/RequestRepository.js';
import type { Transport } from './Transport.js';
import type { AdapterRequest, AdapterResponse } from './types.js';
import { NotFoundError, ConflictError } from '../errors.js';

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
   * Flow:
   *   1. Correlate to existing dialog (Dialog Manager)
   *   2. Verify task identity
   *   3. Check if (dialog_id, seq) was already processed (Request Repository)
   *   4. If duplicate: return stored result, do NOT re-execute side effect
   *   5. If new: execute mock side effect, record request, return result
   *   6. Transition dialog state as appropriate
   */
  private async handleRequest(request: AdapterRequest): Promise<AdapterResponse> {
    try {
      // Step 1 & 2: Correlate and verify task identity
      const dialog = this.dialogManager.correlate(request.dialog_id, request.task_id);

      // Step 3: Check for duplicate
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

      // Step 4: New request — execute mock side effect
      const result = this.executeMockSideEffect(request.dialog_id, request.payload);

      // Step 5: Record request as processed (durable deduplication)
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

      // Step 6: Transition dialog state
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
      // Handle errors (dialog not found, task identity mismatch, etc.)
      return {
        dialog_id: request.dialog_id,
        task_id:   request.task_id,
        seq:       request.seq,
        status:    'error',
        result:    null,
        error:     error instanceof Error ? error.message : String(error),
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
   * Complete a dialog (transition to COMMITTED).
   *
   * This would typically be called after all requests for a dialog are processed.
   * For testing purposes, we expose this as a public method.
   */
  completeDialog(dialogId: string): void {
    this.dialogManager.transition(dialogId, 'COMMITTED');
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
