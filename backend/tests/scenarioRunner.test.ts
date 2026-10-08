/**
 * Phase 6c — scenario runner on the live runtime (docs/API_DESIGN.md §8, §9).
 * Temp-file DB per test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';

import { SimulationRuntime } from '../src/runtime/SimulationRuntime.js';
import { runScenario } from '../src/scenarios/runner.js';
import { SCENARIOS } from '../src/scenarios/index.js';
import type { ScenarioRegistry, ScenarioResult } from '../src/scenarios/index.js';

let dir: string;
let rt: SimulationRuntime;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nighthawks-scen-'));
  rt  = await SimulationRuntime.create({
    dbPath: path.join(dir, 'scen.db'), maxAttempts: 5, allowReset: true, eventBufferSize: 2000,
  });
});

afterEach(() => {
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Checks every run of a scenario must contain (guards against dropped checks). */
const KEY_CHECKS: Record<string, string[]> = {
  '1': ['retry processed (original never arrived, so not a duplicate)', 'retry correlated to D2/T2, not D1/T1',
        'D1 untouched', 'D2 COMMITTED', 'D1 stays INITIATED'],
  '2': ['request dropped', 'retry processed as new from B\'s view', 'side effect executed once', 'dialog COMMITTED'],
  '3': ['B executed the side effect once', 'retry classified as duplicate', 'side effect not repeated', 'dialog COMMITTED'],
  '4': ['D1/T1 reloaded from the file', 'next_seq derived from durable state', 'retry recognised as duplicate after restart',
        'restarted B ran no side effect', 'dialog RECOVERED'],
  '5': ['same dialog and task recovered', 'in-flight seq 3 reported, next_seq 4', 'seq 3 retry is a duplicate',
        'seq 1 retry is a duplicate', 'no side effect re-run after restart', 'next request gets seq 4 from durable state',
        'only one dialog for the task', 'dialog RECOVERED'],
  '5-request_lost': ['same dialog and task recovered', 'seq 3 retry processed (first arrival)', 'seq 3 processed once',
        'next request gets seq 4 from durable state', 'only one dialog for the task', 'dialog RECOVERED'],
};

const FINAL_STATES: Record<string, string[]> = {
  '1': ['INITIATED', 'COMMITTED'],   // D1 untouched, D2 committed (creation order)
  '2': ['COMMITTED'],
  '3': ['COMMITTED'],
  '4': ['RECOVERED'],
  '5': ['RECOVERED'],
  '5-request_lost': ['RECOVERED'],
};

function expectPassed(result: ScenarioResult, key: string): void {
  const failed = result.assertions.filter(a => !a.ok);
  expect(failed, JSON.stringify(failed)).toEqual([]);
  expect(result.status).toBe('passed');
  expect(result.error).toBeUndefined();
  expect(result.assertions.map(a => a.label)).toEqual(expect.arrayContaining(KEY_CHECKS[key]!));
  expect(result.dialogs.map(d => d.final_state)).toEqual(FINAL_STATES[key]);
  expect(result.dialogs.every(d => d.task_id.startsWith(`s${result.scenario_id}-${result.run_id}-`))).toBe(true);
}

function scenarioEventTypes(result: ScenarioResult): string[] {
  return rt.events(result.events.from - 1, 2000).events
    .filter(e => e.id <= result.events.to && e.actor === 'scenario')
    .map(e => e.type);
}

describe('each scenario passes on the live runtime', () => {
  for (const id of [1, 2, 3, 4, 5]) {
    it(`Scenario ${id}`, async () => {
      const result = await runScenario(rt, id);

      expectPassed(result, String(id));
      expect(result).toMatchObject({ scenario_id: id, title: SCENARIOS[id]!.title });
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.steps[0]!.tone).toBe('head');

      // events: non-empty range, scenario_started … scenario_finished in order
      expect(result.events.to).toBeGreaterThan(result.events.from);
      const types = scenarioEventTypes(result);
      expect(types[0]).toBe('scenario_started');
      expect(types.at(-1)).toBe('scenario_finished');
      expect(types.filter(t => t === 'scenario_assertion')).toHaveLength(result.assertions.length);
      const started = rt.events(result.events.from - 1, 1).events[0]!;
      expect(started).toMatchObject({ type: 'scenario_started', details: { scenario_id: id, run_id: result.run_id } });

      // adapter events from the run sit inside the same range
      const all = rt.events(result.events.from - 1, 2000).events.filter(e => e.id <= result.events.to);
      expect(all.some(e => e.type === 'request_sent')).toBe(true);
      expect(rt.getState().runtime.running_scenario).toBeNull();
      expect(rt.busy).toBe(false);
    });
  }

  it('Scenario 5, request_lost variant', async () => {
    const result = await runScenario(rt, 5, { variant: 'request_lost' });
    expectPassed(result, '5-request_lost');
    expect(rt.events(result.events.from - 1, 1).events[0]!.details).toMatchObject({ variant: 'request_lost' });
  });

  it('all five in a row, twice: unique task ids, no collisions', async () => {
    const runs: ScenarioResult[] = [];
    for (let round = 0; round < 2; round++) {
      for (const id of [1, 2, 3, 4, 5]) runs.push(await runScenario(rt, id));
    }
    expect(runs.every(r => r.status === 'passed')).toBe(true);
    expect(new Set(runs.map(r => r.run_id)).size).toBe(runs.length);
    const taskIds = runs.flatMap(r => r.dialogs.map(d => d.task_id));
    expect(new Set(taskIds).size).toBe(taskIds.length);
  });
});

describe('failure handling', () => {
  it('a throwing script → failed with error; lock and running_scenario released', async () => {
    const registry: ScenarioRegistry = {
      ...SCENARIOS,
      2: {
        title: 'throws',
        script: async (ops, ctx) => {
          await ops.startDialog(ctx.taskId('T1'));
          ctx.check('first check', true);
          throw new Error('script exploded');
        },
      },
    };
    const result = await runScenario(rt, 2, {}, registry);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('script exploded');
    expect(result.steps.at(-1)).toMatchObject({ tone: 'fail', text: 'script error: script exploded' });
    expect(result.dialogs).toHaveLength(1);
    expect(rt.getState().runtime.running_scenario).toBeNull();
    expect(rt.busy).toBe(false);
    await expect(rt.startDialog('after')).resolves.toMatchObject({ task_id: 'after' });   // lock released

    const finished = rt.events(result.events.to - 1, 1).events[0]!;
    expect(finished).toMatchObject({ type: 'scenario_finished', outcome: 'failed', details: { error: 'script exploded' } });
    expect(rt.getScenarioResult<ScenarioResult>(2)?.status).toBe('failed');
  });

  it('a failed check does not throw; the run continues and is marked failed', async () => {
    const registry: ScenarioRegistry = {
      ...SCENARIOS,
      3: {
        title: 'one failing check',
        script: async (_ops, ctx) => {
          ctx.check('good', true);
          const returned = ctx.check('bad', false, 'expected x');
          ctx.check('reached after the failure', returned === false);
        },
      },
    };
    const result = await runScenario(rt, 3, {}, registry);

    expect(result.status).toBe('failed');
    expect(result.error).toBeUndefined();
    expect(result.assertions).toEqual([
      { label: 'good', ok: true, detail: '' },
      { label: 'bad', ok: false, detail: 'expected x' },
      { label: 'reached after the failure', ok: true, detail: '' },
    ]);
  });

  it('a script with no checks is not "passed"', async () => {
    const result = await runScenario(rt, 1, {}, { 1: { title: 'empty', script: async () => {} } });
    expect(result.status).toBe('failed');
  });

  it('running_scenario is set during the run and busy refuses other mutations', async () => {
    let seen: number | null = null;
    let busyError: unknown;
    const registry: ScenarioRegistry = {
      4: {
        title: 'observer',
        script: async (_ops, ctx) => {
          seen = rt.getState().runtime.running_scenario;
          busyError = await rt.startDialog('intruder').catch(e => e);
          ctx.check('observed', true);
        },
      },
    };
    await runScenario(rt, 4, {}, registry);
    expect(seen).toBe(4);
    expect((busyError as Error).name).toBe('RuntimeBusyError');
  });
});

describe('last_result storage', () => {
  it('survives a simulated restart and is cleared by reset', async () => {
    const result = await runScenario(rt, 3);
    expect(rt.getScenarioResult<ScenarioResult>(3)).toEqual(result);

    await rt.restart('A');
    expect(rt.getScenarioResult<ScenarioResult>(3)?.run_id).toBe(result.run_id);

    await rt.reset();
    expect(rt.getScenarioResult(3)).toBeNull();
  });

  it('step_delay_ms slows the run', async () => {
    const t0 = Date.now();
    const result = await runScenario(rt, 2, { step_delay_ms: 20 });
    expect(result.status).toBe('passed');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3 * 20);
  });
});
