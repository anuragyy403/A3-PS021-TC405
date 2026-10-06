/**
 * Express application factory.
 *
 * `createApp` is a pure function: it accepts the database instance and
 * returns a configured Express app.  This separation lets tests inject an
 * isolated in-memory database without starting a real HTTP server.
 *
 * Routes added in this phase:
 *   GET /health   — liveness probe
 *
 * Future phases will add:
 *   POST /api/dialogs
 *   GET  /api/dialogs
 *   GET  /api/dialogs/:id
 *   POST /api/requests
 *   POST /api/scenarios/:id/run
 *   GET  /api/events  (SSE)
 *   etc.
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
  type Express,
} from 'express';
import type { Database } from 'sql.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';

export function createApp(db: Database): Express {
  const app = express();

  // -------------------------------------------------------------------------
  // Request parsing
  // -------------------------------------------------------------------------
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Routes: Phase 2.3 — foundation only
  // -------------------------------------------------------------------------

  /**
   * GET /health
   *
   * Liveness probe.  Returns 200 + JSON when the process is running and the
   * database connection is open.  A closed DB means the server is shutting
   * down gracefully; return 503 so a load balancer can route elsewhere.
   */
  app.get('/health', (_req: Request, res: Response) => {
    // sql.js databases are valid until explicitly closed; check by running
    // a trivial query. If the DB was closed, db.run() will throw.
    let dbStatus = 'open';
    try {
      db.run('SELECT 1');
    } catch {
      dbStatus = 'closed';
    }

    if (dbStatus === 'closed') {
      res.status(503).json({
        status:  'unhealthy',
        reason:  'database connection closed',
        ts:      new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      status:  'ok',
      service: 'nighthawks-backend',
      version: '1.0.0',
      db:      dbStatus,
      ts:      new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // 404 handler (must come AFTER all route registrations)
  // -------------------------------------------------------------------------
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
  });

  // -------------------------------------------------------------------------
  // Centralised error handler
  // Express identifies error middleware by arity (four parameters).
  // -------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      // Operational errors: known, expected, safe to surface
      logger.warn('operational error', { code: err.code, message: err.message, status: err.statusCode });
      res.status(err.statusCode).json({
        error:   err.code,
        message: err.message,
        status:  err.statusCode,
      });
      return;
    }

    // Unexpected errors: log fully, return minimal response (no stack traces)
    logger.error('unhandled error', {
      message: err instanceof Error ? err.message : String(err),
      stack:   err instanceof Error ? err.stack : undefined,
    });

    res.status(500).json({
      error:   'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      status:  500,
    });
  });

  return app;
}
