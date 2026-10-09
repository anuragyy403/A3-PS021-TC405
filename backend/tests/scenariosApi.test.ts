/**
 * Phase 6c — scenario endpoints (E11/E12) and all five scenarios as manual
 * HTTP call sequences (E5–E10 only), mirroring tests/scenarios.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import type { Express } from 'express';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';

import { createApp } from '../src/app.js';
import { SimulationRuntime } from '../src/runtime/SimulationRuntime.js';

let dir: string;
let rt:  SimulationRuntime;
let app: Express;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nighthawks-scenapi-'));
  rt  = await SimulationRuntime.create({
    dbPath: path.join(dir, 'scenapi.db'), maxAttempts: 5, allowReset: true, eventBufferSize: 2000,
  });
  app = createApp(rt);
});

afterEach(() => {
  if (rt.isOpen()) rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get  = (url: string) => request(app).get(url);
const post = (url: string, body?: object) => (body === undefined ? request(app).post(url) : request(app).post(url).send(body));
const D    = (id: string) => `/api/dialogs/${id}`;

function expectError(res: Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ error: code, status });
}

async function dialog(id: string) {
  return (await get(D(id))).body.dialog;
}

// ===========================================================================
// E11 GET /api/scenarios
// ===========================================================================

describe('E11 GET /api/scenarios', () => {
  it('lists five with the exact describe() titles of tests/scenarios.test.ts', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'scenarios.test.ts'), 'utf8');
    const titles = [...source.matchAll(/describe\('(Scenario \d — [^']+)'/g)].map(m => m[1]);
    expect(titles).toHaveLength(5);

    const res = await get('/api/scenarios');
    expect(res.status).toBe(200);
    expect(res.body.running).toBeNull();
    expect(res.body.scenarios.map((s: { id: number }) => s.id)).toEqual([1, 2, 3, 4, 5]);
    expect(res.body.scenarios.map((s: { title: string }) => s.title)).toEqual(titles);
    expect(res.body.scenarios.every((s: { last_result: unknown }) => s.last_result === null)).toBe(true);
  });

  it('last_result is set after a run', async () => {
    const run = await post('/api/scenarios/3/run', {});
    const res = await get('/api/scenarios');
    expect(res.body.scenarios[2].last_result).toEqual(run.body);
    expect(res.body.scenarios[0].last_result).toBeNull();
  });
});

// ===========================================================================
// E12 POST /api/scenarios/:id/run
// ===========================================================================

describe('E12 POST /api/scenarios/:id/run', () => {
  for (const id of [1, 2, 3, 4, 5]) {
    it(`scenario ${id} → 200 passed`, async () => {
      const res = await post(`/api/scenarios/${id}/run`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ scenario_id: id, status: 'passed' });
      expect(Object.keys(res.body).sort()).toEqual([
        'assertions', 'dialogs', 'duration_ms', 'events', 'run_id', 'scenario_id',
        'started_at', 'status', 'steps', 'title',
      ]);
      expect(res.body.assertions.every((a: { ok: boolean }) => a.ok)).toBe(true);
    });
  }

  it('scenario 5 request_lost variant', async () => {
    const res = await post('/api/scenarios/5/run', { variant: 'request_lost' });
    expect(res.body).toMatchObject({ status: 'passed', dialogs: [{ final_state: 'RECOVERED', restored: true }] });
    expect(res.body.assertions.map((a: { label: string }) => a.label)).toContain('seq 3 retry processed (first arrival)');
  });

  it('400: variant on another id, bad variant, unknown key, step_delay_ms out of range', async () => {
    expectError(await post('/api/scenarios/3/run', { variant: 'request_lost' }), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/scenarios/5/run', { variant: 'bogus' }), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/scenarios/1/run', { speed: 2 }), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/scenarios/1/run', { step_delay_ms: 1001 }), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/scenarios/1/run', { step_delay_ms: -1 }), 400, 'VALIDATION_ERROR');
  });

  it('404 SCENARIO_NOT_FOUND for ids outside 1..5, including non-numeric', async () => {
    for (const id of ['0', '6', 'abc', '1.5', '-1']) {
      expectError(await post(`/api/scenarios/${id}/run`), 404, 'SCENARIO_NOT_FOUND');
    }
  });

  it('409 RUNTIME_BUSY during a paced run; GETs show the run; afterwards mutations work', async () => {
    const running = post('/api/scenarios/2/run', { step_delay_ms: 60 }).then(r => r);   // not awaited
    for (let i = 0; i < 100 && !rt.busy; i++) await new Promise(r => setTimeout(r, 5));
    expect(rt.busy).toBe(true);

    expectError(await post('/api/dialogs', { task_id: 'manual' }), 409, 'RUNTIME_BUSY');
    expectError(await post('/api/scenarios/1/run'), 409, 'RUNTIME_BUSY');
    expectError(await post('/api/adapters/A/restart'), 409, 'RUNTIME_BUSY');

    const state = await get('/api/state');
    expect(state.body.runtime).toMatchObject({ busy: true, running_scenario: 2 });
    expect((await get('/api/scenarios')).body.running).toBe(2);

    const done = await running;
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('passed');
    expect((await get('/api/state')).body.runtime).toMatchObject({ busy: false, running_scenario: null });
    expect((await post('/api/dialogs', { task_id: 'manual' })).status).toBe(201);
  });

  it('scenario dialogs appear in /api/state with their final states; scenario events in /api/events', async () => {
    for (const id of [1, 2, 3, 4, 5]) await post(`/api/scenarios/${id}/run`);
    const dialogs = (await get('/api/state')).body.dialogs as { task_id: string; state: string }[];
    expect(dialogs).toHaveLength(6);   // S1 has two dialogs
    const byScenario = (n: number) => dialogs.filter(d => d.task_id.startsWith(`s${n}-`)).map(d => d.state).sort();
    expect(byScenario(1)).toEqual(['COMMITTED', 'INITIATED']);
    expect(byScenario(4)).toEqual(['RECOVERED']);
    expect(byScenario(5)).toEqual(['RECOVERED']);

    const types = new Set((await get('/api/events?limit=500')).body.events.map((e: { type: string }) => e.type));
    for (const t of ['scenario_started', 'scenario_step', 'scenario_assertion', 'scenario_finished']) {
      expect(types.has(t)).toBe(true);
    }
  });
});

describe('413 PAYLOAD_TOO_LARGE', () => {
  it('a body over the 100kb limit', async () => {
    const res = await post('/api/dialogs', { task_id: 'x'.repeat(200_000) });
    expectError(res, 413, 'PAYLOAD_TOO_LARGE');
  });
});

// ===========================================================================
// The five scenarios as manual HTTP sequences (E5–E10 only)
// ===========================================================================

describe('manual HTTP sequences mirroring tests/scenarios.test.ts', () => {
  it('Scenario 1 — Multiple Dialogs + Retry → Correct Correlation', async () => {
    const d1 = (await post('/api/dialogs', { task_id: 'task-1' })).body.dialog.dialog_id;
    const d2 = (await post('/api/dialogs', { task_id: 'task-2' })).body.dialog.dialog_id;
    expect(d2).not.toBe(d1);

    const lost = await post(`${D(d2)}/requests`, { payload: { op: 'd2-work' }, fault: 'drop_request' });
    expect(lost.body).toMatchObject({ seq: 1, delivery: 'request_dropped', dialog: { processed_count: 0, pending_seqs: [1] } });

    const retry = await post(`${D(d2)}/requests/1/retry`);
    expect(retry.body).toMatchObject({
      outcome: 'ok', response: { dialog_id: d2, task_id: 'task-2', status: 'ok' },
    });
    expect(await dialog(d2)).toMatchObject({ processed_count: 1, side_effects_since_boot: 1 });
    expect(await dialog(d1)).toMatchObject({ processed_count: 0, side_effects_since_boot: 0 });

    expect((await post(`${D(d2)}/complete`)).body.dialog.state).toBe('COMMITTED');
    expect((await dialog(d1)).state).toBe('INITIATED');
  });

  it('Scenario 2 — Request Lost → Retry', async () => {
    const d = (await post('/api/dialogs', { task_id: 'task-scenario2' })).body.dialog.dialog_id;
    const lost = await post(`${D(d)}/requests`, { payload: { op: 'work' }, fault: 'drop_request' });
    expect(lost.body).toMatchObject({ delivery: 'request_dropped', dialog: { processed_count: 0, pending_seqs: [1], next_seq: 2 } });

    const retry = await post(`${D(d)}/requests/1/retry`);
    expect(retry.body).toMatchObject({ outcome: 'ok', dialog: { processed_count: 1, state: 'PROCESSING', pending_seqs: [] } });
    expect((await post(`${D(d)}/complete`)).body.dialog.state).toBe('COMMITTED');
  });

  it('Scenario 3 — Response Lost → Duplicate Request', async () => {
    const d = (await post('/api/dialogs', { task_id: 'task-scenario3' })).body.dialog.dialog_id;
    const lost = await post(`${D(d)}/requests`, { payload: { op: 'critical-work' }, fault: 'drop_response' });
    expect(lost.body).toMatchObject({
      delivery: 'response_dropped', dialog: { processed_count: 1, side_effects_since_boot: 1, pending_seqs: [1] },
    });

    const retry = await post(`${D(d)}/requests/1/retry`);
    expect(retry.body).toMatchObject({
      outcome: 'duplicate', dialog: { processed_count: 1, side_effects_since_boot: 1, pending_seqs: [] },
    });
    expect((await post(`${D(d)}/complete`)).body.dialog.state).toBe('COMMITTED');
  });

  it('Scenario 4 — Adapter B Restart → Durable State Recovery', async () => {
    const d = (await post('/api/dialogs', { task_id: 'task-scenario4' })).body.dialog.dialog_id;
    await post(`${D(d)}/requests`, { payload: { data: 'before-restart' }, fault: 'drop_response' });
    expect(await dialog(d)).toMatchObject({ state: 'PROCESSING', processed_count: 1 });

    const restart = await post('/api/adapters/B/restart');
    expect(restart.body.recovered).toEqual([
      { dialog_id: d, task_id: 'task-scenario4', state: 'PROCESSING', next_seq: 2, pending_seqs: [1] },
    ]);

    const retry = await post(`${D(d)}/requests/1/retry`);
    expect(retry.body).toMatchObject({
      outcome: 'duplicate', response: { result: { payload: { data: 'before-restart' } } },
      dialog: { side_effects_since_boot: 0, processed_count: 1, pending_seqs: [] },
    });
    expect((await post(`${D(d)}/complete`)).body.dialog).toMatchObject({ state: 'RECOVERED', restored: true });
  });

  for (const variant of ['response_lost', 'request_lost'] as const) {
    it(`Scenario 5 — Mid-Task Disconnect + Adapter A Restart → Resume (${variant})`, async () => {
      const d = (await post('/api/dialogs', { task_id: 'task-scenario5' })).body.dialog.dialog_id;
      expect((await post(`${D(d)}/requests`, { payload: { step: 1 } })).body.outcome).toBe('ok');
      expect((await post(`${D(d)}/requests`, { payload: { step: 2 } })).body.outcome).toBe('ok');
      const s3 = await post(`${D(d)}/requests`, {
        payload: { step: 3 }, fault: variant === 'response_lost' ? 'drop_response' : 'drop_request',
      });
      expect(s3.body.dialog.processed_count).toBe(variant === 'response_lost' ? 3 : 2);

      const restart = await post('/api/adapters/A/restart');
      expect(restart.body.recovered).toEqual([
        { dialog_id: d, task_id: 'task-scenario5', state: 'PROCESSING', next_seq: 4, pending_seqs: [3] },
      ]);
      expect(await dialog(d)).toMatchObject({ restored: true, next_seq: 4, side_effects_since_boot: 0 });

      const r3 = await post(`${D(d)}/requests/3/retry`);
      if (variant === 'response_lost') {
        expect(r3.body).toMatchObject({ outcome: 'duplicate', response: { result: { payload: { step: 3 } } } });
        expect((await post(`${D(d)}/requests/1/retry`)).body.outcome).toBe('duplicate');
        expect((await dialog(d)).side_effects_since_boot).toBe(0);
      } else {
        expect(r3.body).toMatchObject({ outcome: 'ok', response: { result: { payload: { step: 3 } } } });
        expect((await dialog(d)).side_effects_since_boot).toBe(1);
      }

      const s4 = await post(`${D(d)}/requests`, { payload: { step: 4 } });
      expect(s4.body).toMatchObject({ outcome: 'ok', seq: 4, dialog_id: d, task_id: 'task-scenario5' });
      expect((await dialog(d)).side_effects_since_boot).toBe(variant === 'response_lost' ? 1 : 2);

      const forTask = (await get('/api/dialogs')).body.dialogs.filter((x: { task_id: string }) => x.task_id === 'task-scenario5');
      expect(forTask).toHaveLength(1);

      expect((await post(`${D(d)}/complete`)).body.dialog).toMatchObject({
        state: 'RECOVERED', restored: true, processed_count: 4,
      });
    });
  }
});
