/**
 * Express application factory.
 *
 * `createApp` takes the SimulationRuntime — the only object routes talk to —
 * and returns a configured Express app.  Tests build a runtime on a temp-file
 * database and pass it in without starting a real HTTP server.
 *
 * Routes (docs/API_DESIGN.md §2):
 *   GET  /health                                      E1
 *   GET  /api/state                                   E2
 *   GET  /api/dialogs                                 E3
 *   GET  /api/dialogs/:dialogId                       E4
 *   POST /api/dialogs                                 E5
 *   POST /api/dialogs/:dialogId/requests              E6
 *   POST /api/dialogs/:dialogId/requests/:seq/retry   E7
 *   POST /api/dialogs/:dialogId/complete              E8
 *   POST /api/dialogs/:dialogId/fail                  E9
 *   POST /api/adapters/:adapter/restart               E10
 *   GET  /api/scenarios                               E11
 *   POST /api/scenarios/:id/run                       E12
 *   GET  /api/events                                  E13
 *   POST /api/reset                                   E14
 */

import express, { type Express, type Request, type Response } from 'express';

import type { SimulationRuntime } from './runtime/SimulationRuntime.js';
import { errorMiddleware, notFoundHandler } from './http/errorMiddleware.js';
import { dialogRoutes } from './http/routes/dialogs.js';
import { runtimeRoutes } from './http/routes/runtime.js';
import { scenarioRoutes } from './http/routes/scenarios.js';

export function createApp(runtime: SimulationRuntime): Express {
  const app = express();

  app.use(express.json());

  /**
   * GET /health — liveness probe.
   * 503 once the runtime (and its database handle) has been closed.
   */
  app.get('/health', (_req: Request, res: Response) => {
    if (!runtime.isOpen()) {
      res.status(503).json({
        status: 'unhealthy',
        reason: 'database connection closed',
        ts:     new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      status:  'ok',
      service: 'nighthawks-backend',
      version: '1.0.0',
      db:      'open',
      ts:      new Date().toISOString(),
    });
  });

  app.use('/api', runtimeRoutes(runtime));
  app.use('/api', dialogRoutes(runtime));
  app.use('/api', scenarioRoutes(runtime));

  // Unknown route → 404 (must come after all routes)
  app.use(notFoundHandler);

  // Centralised error handler (§5)
  app.use(errorMiddleware);

  return app;
}
