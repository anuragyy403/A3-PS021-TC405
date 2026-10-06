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

/** A dialog with this ID already exists. */
export class ConflictError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} already exists: ${id}`, 'CONFLICT', 409);
  }
}

/** Incoming data failed Zod or manual validation. */
export class ValidationError extends AppError {
  constructor(details: string) {
    super(`Validation error: ${details}`, 'VALIDATION_ERROR', 400);
  }
}
