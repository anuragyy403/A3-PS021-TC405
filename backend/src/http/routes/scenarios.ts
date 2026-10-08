/**
 * Scenario routes — E11 / E12 (docs/API_DESIGN.md §2, §8).
 *
 * Any id that is not one of the registered scenarios — including non-numeric
 * ids — is 404 SCENARIO_NOT_FOUND: the resource simply does not exist.
 */

import { Router } from 'express';

import type { SimulationRuntime } from '../../runtime/SimulationRuntime.js';
import { SCENARIOS, SCENARIO_IDS } from '../../scenarios/index.js';
import type { ScenarioRegistry, ScenarioResult } from '../../scenarios/index.js';
import { runScenario } from '../../scenarios/runner.js';
import { HttpError } from '../errorMiddleware.js';
import { RunScenarioBody, asyncRoute } from '../validation.js';

export function scenarioRoutes(runtime: SimulationRuntime, registry: ScenarioRegistry = SCENARIOS): Router {
  const router = Router();

  function resolveId(raw: string): number {
    const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(id) || registry[id] === undefined) {
      throw new HttpError(404, 'SCENARIO_NOT_FOUND', `Scenario not found: ${raw}`);
    }
    return id;
  }

  // E11 — the five scenarios and the last result of each
  router.get('/scenarios', asyncRoute((_req, res) => {
    res.json({
      scenarios: SCENARIO_IDS.filter(id => registry[id] !== undefined).map(id => ({
        id,
        title:       registry[id]!.title,
        last_result: runtime.getScenarioResult<ScenarioResult>(id),
      })),
      running: runtime.runningScenarioId,
    });
  }));

  // E12 — run one scenario on the live runtime (holds the lock for the whole run)
  router.post('/scenarios/:id/run', asyncRoute(async (req, res) => {
    const id = resolveId(String(req.params['id']));
    const { step_delay_ms, variant } = RunScenarioBody.parse(req.body);
    if (variant !== undefined && id !== 5) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'variant is only accepted for scenario 5');
    }
    res.json(await runScenario(runtime, id, { step_delay_ms, ...(variant ? { variant } : {}) }, registry));
  }));

  return router;
}
