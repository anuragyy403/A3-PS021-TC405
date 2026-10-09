/**
 * Centralised error types for the Nighthawks backend.
 *
 * Using typed error classes keeps error handling predictable and lets the
 * Express error middleware map each class to the right HTTP status without
 * inspecting strings.
 */

/** Base class — all application errors extend this. */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code:       string;

  constructor(message: string, code: string, statusCode = 500) {
    super(message);
    this.name       = this.constructor.name;
    this.code       = code;
    this.statusCode = statusCode;

    // Maintains correct prototype chain in environments that transpile classes.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The requested resource (dialog, request record) does not exist. */
export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
  }
}

/** The caller attempted an invalid lifecycle transition. */
export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(
      `Invalid lifecycle transition: ${from} → ${to}`,
      'INVALID_TRANSITION',
      409, // Conflict — the current state cannot accept this transition
    );
  }
}

/**
 * The request conflicts with current state (e.g. a dialog with this ID
 * already exists).  `message` overrides the default "already exists" text.
 */
export class ConflictError extends AppError {
  constructor(resource: string, id: string, message?: string) {
    super(message ?? `${resource} already exists: ${id}`, 'CONFLICT', 409);
  }
}

/** An incoming request carries a task_id that differs from the stored one. */
export class TaskMismatchError extends ConflictError {
  constructor(dialogId: string, expected: string, got: string) {
    super(
      'Task identity',
      dialogId,
      `Task identity mismatch for dialog ${dialogId}: expected task ${expected}, got ${got}`,
    );
  }
}

/** The dialog is in a terminal state and cannot accept new work. */
export class DialogTerminalError extends AppError {
  constructor(dialogId: string, state: string) {
    super(
      `Dialog ${dialogId} is in terminal state ${state} and cannot accept new requests`,
      'DIALOG_TERMINAL',
      409,
    );
  }
}

/** A runtime mutation was attempted while another one holds the lock. */
export class RuntimeBusyError extends AppError {
  constructor() {
    super('Runtime is busy with another operation; try again', 'RUNTIME_BUSY', 409);
  }
}

/** The demo-only reset is disabled, or refused for this database path. */
export class ResetDisabledError extends AppError {
  constructor(reason = 'Reset is disabled (ALLOW_RESET)') {
    super(reason, 'RESET_DISABLED', 403);
  }
}

/** Incoming data failed Zod or manual validation. */
export class ValidationError extends AppError {
  constructor(details: string) {
    super(`Validation error: ${details}`, 'VALIDATION_ERROR', 400);
  }
}
