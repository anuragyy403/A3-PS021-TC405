/**
 * Runtime-level routes — E2 state, E10 restart, E13 events, E14 reset
 * (docs/API_DESIGN.md §2).
 */

import { Router } from 'express';

import type { SimulationRuntime } from '../../runtime/SimulationRuntime.js';
import { AdapterParams, EmptyBody, EventsQuery, ResetBody, asyncRoute } from '../validation.js';

export function runtimeRoutes(runtime: SimulationRuntime): Router {
  const router = Router();

  // E2 — snapshot
  router.get('/state', asyncRoute((_req, res) => {
    res.json(runtime.getState());
  }));

  // E10 — full process restart + recover() (both targets; §1)
  router.post('/adapters/:adapter/restart', asyncRoute(async (req, res) => {
    const { adapter } = AdapterParams.parse(req.params);
    EmptyBody.parse(req.body);
    res.json(await runtime.restart(adapter));
  }));

  // E13 — events after a cursor
  router.get('/events', asyncRoute((req, res) => {
    const { since, limit } = EventsQuery.parse(req.query);
    res.json(runtime.events(since, limit));
  }));

  // E14 — demo-only reset
  router.post('/reset', asyncRoute(async (req, res) => {
    ResetBody.parse(req.body);
    res.json(await runtime.reset());
  }));

  return router;
}
