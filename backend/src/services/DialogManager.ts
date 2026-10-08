/**
 * Dialog Manager — PS-021 business logic layer.
 *
 * Responsibilities:
 *   - Create dialogs
 *   - Load/retrieve dialogs
 *   - Correlate incoming requests to existing dialogs
 *   - Validate lifecycle state transitions
 *   - Update dialog state
 *   - Mark dialogs as restored after recovery
 *   - Preserve task identity through the repository layer
 *
 * The Dialog Manager owns business rules; the repository owns persistence.
 *
 * Correlation:
 *   Uses dialog_id to locate the correct dialog.
 *   Does NOT use seq alone or task_id alone.
 *
 * Deduplication:
 *   Remains the responsibility of RequestRepository with key (dialog_id, seq).
 *   Dialog Manager focuses on dialog/task correlation, not request dedup.
 *
 * Lifecycle:
 *   Enforces the 5-state model with explicit transition validation.
 *   Terminal states (COMMITTED, RECOVERED, FAILED) cannot transition further.
 */

import type { Database } from 'sql.js';
import { DialogRepository } from '../repositories/DialogRepository.js';
import type { DialogRecord, LifecycleState } from '../types/index.js';
import { canTransition, isTerminal } from '../types/index.js';
import {
  NotFoundError,
  InvalidTransitionError,
  ConflictError,
  TaskMismatchError,
} from '../errors.js';

export class DialogManager {
  private readonly dialogRepo: DialogRepository;

  constructor(db: Database, dbPath: string) {
    this.dialogRepo = new DialogRepository(db, dbPath);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Create a new dialog with the given identifiers.
   *
   * Initial state is always INITIATED.
   * restored flag is always false for a newly created dialog.
   *
   * Throws ConflictError if dialog_id already exists.
   */
  createDialog(dialogId: string, taskId: string): DialogRecord {
    // Check if dialog already exists
    const existing = this.dialogRepo.findById(dialogId);
    if (existing !== null) {
      throw new ConflictError('Dialog', dialogId);
    }

    const record: DialogRecord = {
      dialog_id: dialogId,
      task_id:   taskId,
      state:     'INITIATED',
      restored:  false,
    };

    this.dialogRepo.create(record);

    return record;
  }

  // -------------------------------------------------------------------------
  // Retrieve
  // -------------------------------------------------------------------------

  /**
   * Retrieve a dialog by its dialog_id.
   * Returns null if the dialog does not exist.
   */
  getDialog(dialogId: string): DialogRecord | null {
    return this.dialogRepo.findById(dialogId);
  }

  /**
   * Retrieve a dialog by its dialog_id.
   * Throws NotFoundError if the dialog does not exist.
   *
   * Use this when the dialog MUST exist (e.g., during correlation).
   */
  requireDialog(dialogId: string): DialogRecord {
    const dialog = this.dialogRepo.findById(dialogId);
    if (dialog === null) {
      throw new NotFoundError('Dialog', dialogId);
    }
    return dialog;
  }

  /**
   * Retrieve all dialogs currently in non-terminal states.
   * Used by recovery logic to reload active dialogs on startup.
   */
  getActiveDialogs(): DialogRecord[] {
    return this.dialogRepo.findActive();
  }

  /**
   * Retrieve all dialogs (for diagnostics/testing).
   */
  getAllDialogs(): DialogRecord[] {
    return this.dialogRepo.findAll();
  }

  // -------------------------------------------------------------------------
  // Correlation
  // -------------------------------------------------------------------------

  /**
   * Correlate an incoming request to an existing dialog.
   *
   * Correlation answer: "Which existing dialog does this request belong to?"
   *
   * Uses dialog_id as the correlation key.
   * Verifies that task_id matches (task identity must not change).
   *
   * Throws NotFoundError if dialog_id does not exist.
   * Throws TaskMismatchError (a ConflictError) if task_id does not match the
   * stored task_id.
   *
   * Returns the existing dialog record.
   *
   * NOTE: Correlation does NOT use seq alone or task_id alone.
   *       seq is used for deduplication (handled separately by RequestRepository).
   */
  correlate(dialogId: string, taskId: string): DialogRecord {
    const dialog = this.requireDialog(dialogId);

    // Verify task identity has not changed
    if (dialog.task_id !== taskId) {
      throw new TaskMismatchError(dialogId, dialog.task_id, taskId);
    }

    return dialog;
  }

  // -------------------------------------------------------------------------
  // Lifecycle Transitions
  // -------------------------------------------------------------------------

  /**
   * Transition a dialog to a new lifecycle state.
   *
   * Validates that the transition is allowed according to VALID_TRANSITIONS.
   * Preserves task_id (task identity must not change during transition).
   * Does NOT automatically set restored flag (use markRestored for that).
   *
   * Throws NotFoundError if dialog does not exist.
   * Throws InvalidTransitionError if transition is not allowed.
   */
  transition(dialogId: string, newState: LifecycleState): DialogRecord {
    const dialog = this.requireDialog(dialogId);

    // Terminal states cannot transition
    if (isTerminal(dialog.state)) {
      throw new InvalidTransitionError(dialog.state, newState);
    }

    // Validate transition
    if (!canTransition(dialog.state, newState)) {
      throw new InvalidTransitionError(dialog.state, newState);
    }

    // Perform transition (preserves task_id and restored flag)
    this.dialogRepo.updateState(dialogId, newState, dialog.restored);

    // Return updated record
    return this.requireDialog(dialogId);
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Mark a dialog as restored after recovery.
   *
   * Sets restored flag to true.
   * Does NOT change the lifecycle state.
   *
   * Use this when a dialog is reloaded from durable storage after a crash
   * to indicate that it has been through recovery.
   *
   * Throws NotFoundError if dialog does not exist.
   */
  markRestored(dialogId: string): DialogRecord {
    const dialog = this.requireDialog(dialogId);

    // Set restored flag (preserves current state and task_id)
    this.dialogRepo.updateState(dialogId, dialog.state, true);

    // Return updated record
    return this.requireDialog(dialogId);
  }

  /**
   * Combined operation: transition to RECOVERED and mark as restored.
   *
   * This is a convenience method for the common recovery completion path:
   * work finishes after a restart → transition to RECOVERED + mark restored.
   *
   * Throws NotFoundError if dialog does not exist.
   * Throws InvalidTransitionError if transition to RECOVERED is not allowed.
   */
  transitionToRecovered(dialogId: string): DialogRecord {
    const dialog = this.requireDialog(dialogId);

    // Validate transition to RECOVERED
    if (!canTransition(dialog.state, 'RECOVERED')) {
      throw new InvalidTransitionError(dialog.state, 'RECOVERED');
    }

    // Transition to RECOVERED and set restored flag in one operation
    this.dialogRepo.updateState(dialogId, 'RECOVERED', true);

    // Return updated record
    return this.requireDialog(dialogId);
  }
}
