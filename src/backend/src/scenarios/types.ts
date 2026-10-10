/**
 * Scenario module types (docs/API_DESIGN.md §8).
 *
 * A scenario script drives the LIVE runtime through the unlocked RuntimeOps it
 * receives (the runner holds the lock for the whole run) and reads state
 * through `read`.  It records expectations with ctx.check(); a failed check
 * never throws — it is recorded and the script continues.
 */

import type { LifecycleState } from '../types/index.js';
import type { RuntimeOps, SimulationRuntime } from '../runtime/SimulationRuntime.js';

export type ScenarioId = 1 | 2 | 3 | 4 | 5;

export type StepTone = 'head' | 'info' | 'warn' | 'pass' | 'fail';

export type Scenario5Variant = 'response_lost' | 'request_lost';

export interface ScenarioStep {
  at:   string;
  text: string;
  tone: StepTone;
}

export interface ScenarioAssertion {
  label:  string;
  ok:     boolean;
  detail: string;
}

export interface ScenarioDialog {
  dialog_id:   string;
  task_id:     string;
  final_state: LifecycleState;
  restored:    boolean;
}

export interface ScenarioResult {
  scenario_id: number;
  run_id:      string;
  title:       string;
  status:      'passed' | 'failed';   // failed if any check failed, none ran, or the script threw
  started_at:  string;
  duration_ms: number;
  steps:       ScenarioStep[];
  assertions:  ScenarioAssertion[];
  dialogs:     ScenarioDialog[];
  events:      { from: number; to: number };
  error?:      string;
}

export interface ScenarioContext {
  /** Narrate a step (also emits scenario_step). */
  step(text: string, tone?: 'head' | 'info' | 'warn'): void;
  /** Record an expectation (also emits scenario_assertion).  Never throws. */
  check(label: string, ok: boolean, detail?: string): boolean;
  /** Task id unique to this run, e.g. `s4-r1a2b3-T1`. */
  taskId(suffix: string): string;
  /** Wait step_delay_ms (0 in tests) so a polling UI can animate the run. */
  pause(): Promise<void>;
}

/** Read-only runtime access for scripts. */
export type ScenarioReads = Pick<SimulationRuntime, 'getDialog' | 'listDialogs'>;

export interface ScenarioOptions {
  variant: Scenario5Variant;
  read:    ScenarioReads;
}

export type ScenarioScript = (ops: RuntimeOps, ctx: ScenarioContext, opts: ScenarioOptions) => Promise<void>;

export interface ScenarioDefinition {
  title:  string;
  script: ScenarioScript;
}

export type ScenarioRegistry = Record<number, ScenarioDefinition>;
