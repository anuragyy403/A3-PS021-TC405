/**
 * Scenario runner (docs/API_DESIGN.md §8, §9).
 *
 * One run holds the runtime lock for its whole duration and uses the unlocked
 * RuntimeOps, so manual mutations during a run get 409 RUNTIME_BUSY while
 * GETs keep working.  running_scenario and the lock are always released, even
 * if the script throws; a throwing script yields status 'failed' with `error`.
 */

import { randomBytes } from 'node:crypto';

import { NotFoundError } from '../errors.js';
import type { SimulationRuntime } from '../runtime/SimulationRuntime.js';
import { SCENARIOS } from './index.js';
import type {
  Scenario5Variant,
  ScenarioAssertion,
  ScenarioContext,
  ScenarioRegistry,
  ScenarioResult,
  ScenarioStep,
  StepTone,
} from './types.js';

export interface RunOptions {
  step_delay_ms?: number;
  variant?:       Scenario5Variant;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function newRunId(): string {
  return `r${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

export async function runScenario(
  runtime:  SimulationRuntime,
  id:       number,
  options:  RunOptions = {},
  registry: ScenarioRegistry = SCENARIOS,
): Promise<ScenarioResult> {
  const definition = registry[id];
  if (definition === undefined) throw new NotFoundError('Scenario', String(id));

  const delay   = Math.max(0, options.step_delay_ms ?? 0);
  const variant = options.variant ?? 'response_lost';

  return runtime.withLock(async ops => {
    const runId      = newRunId();
    const taskPrefix = `s${id}-${runId}-`;
    const started    = new Date();
    const from       = runtime.latestEventId() + 1;
    const steps:      ScenarioStep[]      = [];
    const assertions: ScenarioAssertion[] = [];
    const base = { scenario_id: id, run_id: runId };
    let error: string | undefined;

    const addStep = (text: string, tone: StepTone): void => {
      steps.push({ at: new Date().toISOString(), text, tone });
      runtime.emitScenarioEvent({ type: 'scenario_step', details: { ...base, text, tone } });
    };

    const ctx: ScenarioContext = {
      step: (text, tone = 'info') => addStep(text, tone),
      check: (label, ok, detail = '') => {
        const passed = Boolean(ok);
        assertions.push({ label, ok: passed, detail });
        runtime.emitScenarioEvent({
          type: 'scenario_assertion', outcome: passed ? 'ok' : 'failed',
          details: { ...base, label, ok: passed, detail },
        });
        addStep(`${passed ? 'PASS' : 'FAIL'} · ${label}${detail ? ` — ${detail}` : ''}`, passed ? 'pass' : 'fail');
        return passed;
      },
      taskId: suffix => `${taskPrefix}${suffix}`,
      pause:  () => (delay > 0 ? sleep(delay) : Promise.resolve()),
    };

    runtime.setRunningScenario(id);
    try {
      runtime.emitScenarioEvent({
        type: 'scenario_started',
        details: { ...base, title: definition.title, ...(id === 5 ? { variant } : {}) },
      });
      try {
        await definition.script(ops, ctx, { variant, read: runtime });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        addStep(`script error: ${error}`, 'fail');
      }

      const passed = error === undefined && assertions.length > 0 && assertions.every(a => a.ok);
      const status: ScenarioResult['status'] = passed ? 'passed' : 'failed';
      const durationMs = Date.now() - started.getTime();

      runtime.emitScenarioEvent({
        type: 'scenario_finished', outcome: status,
        details: { ...base, status, duration_ms: durationMs, ...(error !== undefined ? { error } : {}) },
      });

      const result: ScenarioResult = {
        ...base,
        title:       definition.title,
        status,
        started_at:  started.toISOString(),
        duration_ms: durationMs,
        steps,
        assertions,
        // Ordered by task id (T1, T2, …): deterministic even when two dialogs
        // were created in the same millisecond.
        dialogs: runtime.listDialogs()
          .filter(d => d.task_id.startsWith(taskPrefix))
          .sort((a, b) => a.task_id.localeCompare(b.task_id))
          .map(d => ({ dialog_id: d.dialog_id, task_id: d.task_id, final_state: d.state, restored: d.restored })),
        events: { from, to: runtime.latestEventId() },
        ...(error !== undefined ? { error } : {}),
      };
      runtime.setScenarioResult(id, result);
      return result;
    } finally {
      runtime.setRunningScenario(null);
    }
  });
}
