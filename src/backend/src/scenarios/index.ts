/**
 * Scenario registry.  Titles are exactly the describe() names in
 * tests/scenarios.test.ts.
 */

import { scenario1 } from './scenario1.js';
import { scenario2 } from './scenario2.js';
import { scenario3 } from './scenario3.js';
import { scenario4 } from './scenario4.js';
import { scenario5 } from './scenario5.js';
import type { ScenarioRegistry } from './types.js';

export const SCENARIOS: ScenarioRegistry = {
  1: { title: 'Scenario 1 — Multiple Dialogs + Retry → Correct Correlation',     script: scenario1 },
  2: { title: 'Scenario 2 — Request Lost → Retry',                               script: scenario2 },
  3: { title: 'Scenario 3 — Response Lost → Duplicate Request',                  script: scenario3 },
  4: { title: 'Scenario 4 — Adapter B Restart → Durable State Recovery',         script: scenario4 },
  5: { title: 'Scenario 5 — Mid-Task Disconnect + Adapter A Restart → Resume',   script: scenario5 },
};

export const SCENARIO_IDS = [1, 2, 3, 4, 5] as const;

export type * from './types.js';
