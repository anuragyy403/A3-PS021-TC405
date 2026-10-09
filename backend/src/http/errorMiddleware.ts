/**
 * HTTP error mapping (docs/API_DESIGN.md §5).
 *
 * One JSON shape for every error: { error, message, status, details? }
 * (ApiError in types/index.ts plus optional details).  Stack traces and file
 * paths never reach the client; unexpected errors are logged server-side.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import {
  AppError,
  ConflictError,
  DialogTerminalError,
  InvalidTransitionError,
  NotFoundError,
  ResetDisabledError,
  RuntimeBusyError,
  TaskMismatchError,
  ValidationError,
} from '../errors.js';
import { logger } from '../logger.js';
import type { ApiError } from '../types/index.js';

export interface ApiErrorBody extends ApiError {
  details?: unknown;
}

/**
 * An error whose HTTP code was decided by a route, e.g. REQUEST_NOT_FOUND vs
 * DIALOG_NOT_FOUND, or PENDING_REQUESTS with the pending seqs.  Lives in the
 * HTTP layer only; it does not change any domain error class.
 */
export class HttpError extends AppError {
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message, code, status);
    if (details !== undefined) this.details = details;
  }
}

/** body-parser marks its errors with a `type` (malformed JSON: status 400; too large: 413). */
function bodyParserType(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { type?: unknown }).type : undefined;
}

function isMalformedJson(err: unknown): boolean {
  return bodyParserType(err) === 'entity.parse.failed';
}

function body(status: number, error: string, message: string, details?: unknown): ApiErrorBody {
  return details === undefined ? { error, message, status } : { error, message, status, details };
}

/**
 * Map any thrown value to the API error body.  Order matters:
 * TaskMismatchError is a ConflictError, so it is checked first.
 */
export function toApiError(err: unknown): ApiErrorBody {
  if (err instanceof ZodError) {
    return body(400, 'VALIDATION_ERROR', 'Request validation failed', err.issues);
  }
  if (isMalformedJson(err)) {
    return body(400, 'VALIDATION_ERROR', 'Malformed JSON body');
  }
  if (bodyParserType(err) === 'entity.too.large') return body(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  if (err instanceof HttpError)              return body(err.statusCode, err.code, err.message, err.details);
  if (err instanceof ValidationError)        return body(400, 'VALIDATION_ERROR', err.message);
  if (err instanceof NotFoundError)          return body(404, 'DIALOG_NOT_FOUND', err.message);
  if (err instanceof TaskMismatchError)      return body(409, 'TASK_MISMATCH', err.message);
  if (err instanceof ConflictError)          return body(409, 'CONFLICT', err.message);
  if (err instanceof InvalidTransitionError) return body(409, 'INVALID_TRANSITION', err.message);
  if (err instanceof DialogTerminalError)    return body(409, 'DIALOG_TERMINAL', err.message);
  if (err instanceof RuntimeBusyError)       return body(409, 'RUNTIME_BUSY', err.message);
  if (err instanceof ResetDisabledError)     return body(403, 'RESET_DISABLED', err.message);
  if (err instanceof AppError)               return body(err.statusCode, err.code, err.message);
  return body(500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred');
}

/** Express error middleware (four parameters). */
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const mapped = toApiError(err);

  if (mapped.status >= 500) {
    logger.error('unhandled error', {
      message: err instanceof Error ? err.message : String(err),
      stack:   err instanceof Error ? err.stack : undefined,
    });
  } else {
    logger.warn('request rejected', { code: mapped.error, status: mapped.status });
  }

  res.status(mapped.status).json(mapped);
}

/** Unknown route → 404 NOT_FOUND (shape unchanged from the original app.ts). */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found', status: 404 });
}
