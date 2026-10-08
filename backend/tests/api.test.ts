/**
 * Phase 6b — HTTP API (docs/API_DESIGN.md §2–§5, §15).
 *
 * supertest against createApp(runtime); every test gets its own temp
 * directory and SQLite FILE.  Every response passes through call(), which
 * asserts no stack trace and no full database path ever reach the client.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import type { Express } from 'express';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';
import { z } from 'zod';

import { createApp } from '../src/app.js';
import { SimulationRuntime, RESTART_NOTE } from '../src/runtime/SimulationRuntime.js';
import type { RuntimeConfig } from '../src/runtime/SimulationRuntime.js';
import { toApiError, HttpError } from '../src/http/errorMiddleware.js';
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
} from '../src/errors.js';

let dir: string;
let rt:  SimulationRuntime;
let app: Express;

async function boot(over: Partial<RuntimeConfig> = {}): Promise<void> {
  rt  = await SimulationRuntime.create({
    dbPath: path.join(dir, 'api.db'), maxAttempts: 5, allowReset: true, eventBufferSize: 1000, ...over,
  });
  app = createApp(rt);
}

/** Replace the runtime (same directory) with a differently configured one. */
async function reboot(over: Partial<RuntimeConfig>): Promise<void> {
  rt.close();
  await boot(over);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nighthawks-api-'));
  await boot();
});

afterEach(() => {
  if (rt.isOpen()) rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** No response may contain a stack trace or the (unique) temp directory. */
function assertClean(res: Response): void {
  const text = res.text ?? '';
  expect(text).not.toContain(path.basename(dir));
  expect(text).not.toMatch(/\bat .+\.(ts|js):\d+/);
  expect(text).not.toContain('"stack"');
}

async function get(url: string): Promise<Response> {
  const res = await request(app).get(url);
  assertClean(res);
  return res;
}

async function post(url: string, body?: unknown): Promise<Response> {
  const req = request(app).post(url);
  const res = body === undefined ? await req : await req.send(body as object);
  assertClean(res);
  return res;
}

async function postRaw(url: string, raw: string): Promise<Response> {
  const res = await request(app).post(url).set('Content-Type', 'application/json').send(raw);
  assertClean(res);
  return res;
}

function expectError(res: Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ error: code, status });
  expect(typeof res.body.message).toBe('string');
}

async function newDialog(taskId = 'T1'): Promise<string> {
  const res = await post('/api/dialogs', { task_id: taskId });
  expect(res.status).toBe(201);
  return res.body.dialog.dialog_id as string;
}

const D = (id: string) => `/api/dialogs/${encodeURIComponent(id)}`;

// ===========================================================================
// E1 /health
// ===========================================================================

describe('E1 GET /health', () => {
  it('200 while open; 503 after the runtime is closed', async () => {
    expect((await get('/health')).body).toMatchObject({ status: 'ok', db: 'open' });
    rt.close();
    const res = await get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });
});

// ===========================================================================
// E2 /api/state
// ===========================================================================

describe('E2 GET /api/state', () => {
  it('returns runtime, nodes, metrics and dialogs with the §2 fields', async () => {
    const d = await newDialog('T1');
    const res = await get('/api/state');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['dialogs', 'metrics', 'nodes', 'runtime']);
    expect(Object.keys(res.body.runtime).sort()).toEqual([
      'booted_at', 'busy', 'cursor', 'db_path_name', 'epoch', 'max_attempts',
      'restart_count', 'running_scenario', 'uptime_ms',
    ]);
    expect(res.body.runtime).toMatchObject({
      db_path_name: 'api.db', max_attempts: 5, busy: false, running_scenario: null, restart_count: 0, cursor: 1,
    });
    expect(res.body.nodes).toEqual({
      adapterA: { status: 'online' }, adapterB: { status: 'online' },
      transport: { status: 'online' }, storage: { status: 'online' },
    });
    expect(Object.keys(res.body.metrics).sort()).toEqual([
      'booted_at', 'by_state', 'dialogs_total', 'drops_since_boot', 'duplicates_since_boot',
      'processed_count', 'restart_count', 'restored_total', 'side_effects_since_boot',
      'transport_attempts', 'uptime_ms',
    ]);
    expect(res.body.dialogs).toHaveLength(1);
    expect(Object.keys(res.body.dialogs[0]).sort()).toEqual([
      'dialog_id', 'duplicates_since_boot', 'next_seq', 'pending_seqs', 'processed_count',
      'restored', 'side_effects_since_boot', 'state', 'task_id', 'terminal',
    ]);
    expect(res.body.dialogs[0]).toMatchObject({ dialog_id: d, state: 'INITIATED', next_seq: 1 });
  });
});

// ===========================================================================
// E3 / E4
// ===========================================================================

describe('E3 GET /api/dialogs', () => {
  it('newest first, state filter, limit', async () => {
    const a = await newDialog('T-a');
    await new Promise(r => setTimeout(r, 2));   // distinct Date.now() in dialog ids
    const b = await newDialog('T-b');
    await post(`${D(b)}/requests`, { payload: {} });

    expect((await get('/api/dialogs')).body.dialogs.map((x: { dialog_id: string }) => x.dialog_id)).toEqual([b, a]);
    expect((await get('/api/dialogs?state=PROCESSING')).body.dialogs.map((x: { dialog_id: string }) => x.dialog_id)).toEqual([b]);
    expect((await get('/api/dialogs?limit=1')).body.dialogs).toHaveLength(1);
  });

  it('400 on a bad state or limit', async () => {
    expectError(await get('/api/dialogs?state=WAITING_ACK'), 400, 'VALIDATION_ERROR');
    expectError(await get('/api/dialogs?limit=0'), 400, 'VALIDATION_ERROR');
    expectError(await get('/api/dialogs?limit=501'), 400, 'VALIDATION_ERROR');
  });
});

describe('E4 GET /api/dialogs/:dialogId', () => {
  it('dialog + processed + send_log + ledger', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: { step: 1 } });
    await post(`${D(d)}/requests`, { payload: { step: 2 }, fault: 'drop_response' });
    await post(`${D(d)}/requests`, { payload: { step: 3 }, fault: 'drop_request' });

    const res = await get(D(d));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['dialog', 'ledger', 'processed', 'send_log']);
    expect(res.body.processed.map((p: { seq: number }) => p.seq)).toEqual([1, 2]);
    expect(res.body.processed[0]).toMatchObject({ seq: 1, result: { processed: true, payload: { step: 1 } } });
    expect(res.body.send_log[2]).toEqual({ seq: 3, payload: { step: 3 }, status: 'PENDING', attempts: 1 });
    expect(res.body.ledger).toEqual([
      { seq: 1, status: 'acked', attempts: 1 },
      { seq: 2, status: 'processed_unacked', attempts: 1 },
      { seq: 3, status: 'pending_unprocessed', attempts: 1 },
    ]);
  });

  it('404 DIALOG_NOT_FOUND; 400 for an over-long id', async () => {
    expectError(await get(D('dlg-nope')), 404, 'DIALOG_NOT_FOUND');
    expectError(await get(D('x'.repeat(129))), 400, 'VALIDATION_ERROR');
  });
});

// ===========================================================================
// E5 POST /api/dialogs
// ===========================================================================

describe('E5 POST /api/dialogs', () => {
  it('201 { dialog } in INITIATED', async () => {
    const res = await post('/api/dialogs', { task_id: 'task-demo-1' });
    expect(res.status).toBe(201);
    expect(res.body.dialog).toMatchObject({
      task_id: 'task-demo-1', state: 'INITIATED', restored: false, terminal: false, next_seq: 1,
      processed_count: 0, pending_seqs: [], side_effects_since_boot: 0, duplicates_since_boot: 0,
    });
    expect(res.body.dialog.dialog_id).toMatch(/^dlg-\d+-[a-z0-9]+$/);
  });

  it('400 on missing / empty / over-long task_id or unknown keys', async () => {
    expectError(await post('/api/dialogs', {}), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/dialogs', { task_id: '' }), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/dialogs', { task_id: 'x'.repeat(129) }), 400, 'VALIDATION_ERROR');
    const extra = await post('/api/dialogs', { task_id: 'T', dialog_id: 'mine' });
    expectError(extra, 400, 'VALIDATION_ERROR');
    expect(Array.isArray(extra.body.details)).toBe(true);   // zod issues
  });
});

// ===========================================================================
// E6 send
// ===========================================================================

describe('E6 POST /api/dialogs/:id/requests', () => {
  it('ok', async () => {
    const d = await newDialog();
    const res = await post(`${D(d)}/requests`, { payload: { op: 'charge' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dialog_id: d, task_id: 'T1', seq: 1, kind: 'send', delivery: 'delivered', outcome: 'ok',
      dialog_failed: false, send_log: { status: 'ACKED', attempts: 1 },
      response: { status: 'ok', result: { processed: true, payload: { op: 'charge' } } },
    });
    expect(res.body.events).toEqual({ from: 2, to: 6 });
  });

  it('payload defaults to null', async () => {
    const d = await newDialog();
    const res = await post(`${D(d)}/requests`);
    expect(res.body.send_log.payload).toBeNull();
  });

  it('request_dropped and response_dropped are 200 SendResults', async () => {
    const d = await newDialog();
    const lost = await post(`${D(d)}/requests`, { payload: {}, fault: 'drop_request' });
    expect(lost.status).toBe(200);
    expect(lost.body).toMatchObject({
      seq: 1, delivery: 'request_dropped', outcome: 'no_answer', response: null,
      send_log: { status: 'PENDING' }, dialog: { processed_count: 0, pending_seqs: [1] },
    });

    const half = await post(`${D(d)}/requests`, { payload: {}, fault: 'drop_response' });
    expect(half.status).toBe(200);
    expect(half.body).toMatchObject({
      seq: 2, delivery: 'response_dropped', outcome: 'no_answer', response: null,
      dialog: { processed_count: 1, pending_seqs: [1, 2] },
    });
  });

  it('404 unknown dialog; 409 DIALOG_TERMINAL; 400 bad fault / unknown key', async () => {
    expectError(await post(`${D('dlg-nope')}/requests`, { payload: {} }), 404, 'DIALOG_NOT_FOUND');

    const d = await newDialog();
    expectError(await post(`${D(d)}/requests`, { fault: 'drop_everything' }), 400, 'VALIDATION_ERROR');
    expectError(await post(`${D(d)}/requests`, { payload: {}, faults: 'drop_request' }), 400, 'VALIDATION_ERROR');

    await post(`${D(d)}/requests`, { payload: {} });
    await post(`${D(d)}/complete`);
    expectError(await post(`${D(d)}/requests`, { payload: {} }), 409, 'DIALOG_TERMINAL');
  });
});

// ===========================================================================
// E7 retry
// ===========================================================================

describe('E7 POST /api/dialogs/:id/requests/:seq/retry', () => {
  it('duplicate after a lost response', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: { op: 'x' }, fault: 'drop_response' });
    const res = await post(`${D(d)}/requests/1/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      seq: 1, kind: 'retry', delivery: 'delivered', outcome: 'duplicate',
      send_log: { status: 'ACKED', attempts: 2 }, dialog: { processed_count: 1, duplicates_since_boot: 1 },
    });
  });

  it('ok after a lost request; a fault may be applied to the retry', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: {}, fault: 'drop_request' });
    const again = await post(`${D(d)}/requests/1/retry`, { fault: 'drop_request' });
    expect(again.body).toMatchObject({ delivery: 'request_dropped', send_log: { attempts: 2 } });
    const ok = await post(`${D(d)}/requests/1/retry`, {});
    expect(ok.body).toMatchObject({ outcome: 'ok', send_log: { status: 'ACKED', attempts: 3 } });
  });

  it('404 DIALOG_NOT_FOUND vs 404 REQUEST_NOT_FOUND', async () => {
    expectError(await post(`${D('dlg-nope')}/requests/1/retry`), 404, 'DIALOG_NOT_FOUND');
    const d = await newDialog();
    expectError(await post(`${D(d)}/requests/7/retry`), 404, 'REQUEST_NOT_FOUND');
  });

  it('400 when a payload is sent, or the seq is not a positive integer', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: { op: 'original' } });
    expectError(await post(`${D(d)}/requests/1/retry`, { payload: { op: 'changed' } }), 400, 'VALIDATION_ERROR');
    expectError(await post(`${D(d)}/requests/abc/retry`), 400, 'VALIDATION_ERROR');
    expectError(await post(`${D(d)}/requests/0/retry`), 400, 'VALIDATION_ERROR');
    expect((await get(D(d))).body.send_log[0].payload).toEqual({ op: 'original' });
  });

  it('idempotent replay on a finished dialog is allowed', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: {} });
    await post(`${D(d)}/complete`);
    const res = await post(`${D(d)}/requests/1/retry`);
    expect(res.body).toMatchObject({ outcome: 'duplicate', dialog: { state: 'COMMITTED' } });
  });

  it('rejected outcome carries error_code (unprocessed seq on a FAILED dialog)', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: {}, fault: 'drop_request' });
    await post(`${D(d)}/fail`, { reason: 'abort' });
    const res = await post(`${D(d)}/requests/1/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'rejected', error_code: 'DIALOG_TERMINAL' });
  });
});

describe('retry budget via HTTP', () => {
  it('maxAttempts unanswered attempts → dialog_failed, FAILED', async () => {
    await reboot({ maxAttempts: 2 });
    const d = await newDialog();
    const first  = await post(`${D(d)}/requests`, { payload: {}, fault: 'drop_request' });
    expect(first.body.dialog_failed).toBe(false);
    const second = await post(`${D(d)}/requests/1/retry`, { fault: 'drop_request' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ dialog_failed: true, dialog: { state: 'FAILED', terminal: true } });
  });
});

// ===========================================================================
// E8 complete / E9 fail
// ===========================================================================

describe('E8 POST /api/dialogs/:id/complete', () => {
  it('200 COMMITTED', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: {} });
    const res = await post(`${D(d)}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.dialog).toMatchObject({ state: 'COMMITTED', restored: false, terminal: true });
  });

  it('409 PENDING_REQUESTS with details.pending_seqs', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: {} });
    await post(`${D(d)}/requests`, { payload: {}, fault: 'drop_request' });
    const res = await post(`${D(d)}/complete`);
    expectError(res, 409, 'PENDING_REQUESTS');
    expect(res.body.details).toEqual({ pending_seqs: [2] });
  });

  it('409 INVALID_TRANSITION from INITIATED; 404 unknown; 400 unexpected body', async () => {
    const d = await newDialog();
    expectError(await post(`${D(d)}/complete`), 409, 'INVALID_TRANSITION');
    expectError(await post(`${D('dlg-nope')}/complete`), 404, 'DIALOG_NOT_FOUND');
    expectError(await post(`${D(d)}/complete`, { force: true }), 400, 'VALIDATION_ERROR');
  });
});

describe('E9 POST /api/dialogs/:id/fail', () => {
  it('200 FAILED; 400 missing / over-long reason; 404 unknown', async () => {
    const d = await newDialog();
    expectError(await post(`${D(d)}/fail`, {}), 400, 'VALIDATION_ERROR');
    expectError(await post(`${D(d)}/fail`, { reason: 'x'.repeat(201) }), 400, 'VALIDATION_ERROR');
    expectError(await post(`${D('dlg-nope')}/fail`, { reason: 'x' }), 404, 'DIALOG_NOT_FOUND');

    const res = await post(`${D(d)}/fail`, { reason: 'operator abort' });
    expect(res.status).toBe(200);
    expect(res.body.dialog).toMatchObject({ state: 'FAILED', terminal: true });
  });
});

describe('finished dialogs never produce 500 (DECISION 4)', () => {
  it('complete / fail / send on a terminal dialog → 409 DIALOG_TERMINAL, also after a restart', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: {} });
    await post(`${D(d)}/complete`);

    for (const phase of ['before restart', 'after restart']) {
      expectError(await post(`${D(d)}/complete`), 409, 'DIALOG_TERMINAL');
      expectError(await post(`${D(d)}/fail`, { reason: phase }), 409, 'DIALOG_TERMINAL');
      expectError(await post(`${D(d)}/requests`, { payload: {} }), 409, 'DIALOG_TERMINAL');
      await post('/api/adapters/A/restart');
    }
  });
});

// ===========================================================================
// E10 restart
// ===========================================================================

describe('E10 POST /api/adapters/:adapter/restart', () => {
  it('A and B: scope "process", recovered list; the dialog later completes RECOVERED', async () => {
    const d = await newDialog('T-r');
    await post(`${D(d)}/requests`, { payload: {}, fault: 'drop_response' });

    const resB = await post('/api/adapters/B/restart');
    expect(resB.status).toBe(200);
    expect(resB.body).toEqual({
      target: 'B', scope: 'process', note: RESTART_NOTE,
      recovered: [{ dialog_id: d, task_id: 'T-r', state: 'PROCESSING', next_seq: 2, pending_seqs: [1] }],
    });

    const resA = await post('/api/adapters/A/restart');
    expect(resA.body).toMatchObject({ target: 'A', scope: 'process', recovered: [{ dialog_id: d }] });

    await post(`${D(d)}/requests/1/retry`);
    const done = await post(`${D(d)}/complete`);
    expect(done.body.dialog).toMatchObject({ state: 'RECOVERED', restored: true });
    expect((await get('/api/state')).body.runtime.restart_count).toBe(2);
  });

  it('reads from the FILE; durable counts survive, side_effects_since_boot resets', async () => {
    const d = await newDialog('T-original');
    await post(`${D(d)}/requests`, { payload: {} });
    await post(`${D(d)}/requests`, { payload: {}, fault: 'drop_response' });
    const before = (await get('/api/state')).body.metrics;

    rt.database.run(`UPDATE dialogs SET task_id = 'tampered' WHERE dialog_id = ?`, [d]);   // not persisted
    await post('/api/adapters/B/restart');

    expect((await get(D(d))).body.dialog.task_id).toBe('T-original');
    const after = (await get('/api/state')).body.metrics;
    expect(after.processed_count).toBe(before.processed_count);
    expect(after.transport_attempts).toBe(before.transport_attempts);
    expect(before.side_effects_since_boot).toBe(2);
    expect(after.side_effects_since_boot).toBe(0);
  });

  it('400 for an unknown adapter or a body', async () => {
    expectError(await post('/api/adapters/C/restart'), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/adapters/a/restart'), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/adapters/A/restart', { hard: true }), 400, 'VALIDATION_ERROR');
  });
});

// ===========================================================================
// E13 events
// ===========================================================================

describe('E13 GET /api/events', () => {
  it('cursor paging and limit', async () => {
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: {} });    // events 2..6

    const all = await get('/api/events');
    expect(all.status).toBe(200);
    expect(Object.keys(all.body).sort()).toEqual(['cursor', 'epoch', 'events', 'oldest_available', 'truncated']);
    expect(all.body.events.map((e: { id: number }) => e.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(all.body.cursor).toBe(6);

    const page1 = await get('/api/events?since=0&limit=2');
    expect(page1.body.events.map((e: { type: string }) => e.type)).toEqual(['dialog_created', 'request_sent']);
    const page2 = await get(`/api/events?since=${page1.body.cursor}&limit=2`);
    expect(page2.body.events.map((e: { id: number }) => e.id)).toEqual([3, 4]);
    expect((await get('/api/events?since=6')).body).toMatchObject({ events: [], cursor: 6 });
  });

  it('400 on bad since / limit', async () => {
    expectError(await get('/api/events?since=-1'), 400, 'VALIDATION_ERROR');
    expectError(await get('/api/events?since=abc'), 400, 'VALIDATION_ERROR');
    expectError(await get('/api/events?limit=501'), 400, 'VALIDATION_ERROR');
  });

  it('truncated when events after the cursor were evicted', async () => {
    await reboot({ eventBufferSize: 3 });
    const d = await newDialog();
    await post(`${D(d)}/requests`, { payload: {} });     // 6 events, only 3 kept
    const res = await get('/api/events?since=0');
    expect(res.body).toMatchObject({ truncated: true, oldest_available: 4 });
    expect(res.body.events).toHaveLength(3);
    expect((await get('/api/events?since=3')).body.truncated).toBe(false);
  });

  it('epoch changes after reset', async () => {
    await newDialog();
    const before = (await get('/api/events')).body;
    await post('/api/reset', { confirm: 'RESET' });
    const after = (await get(`/api/events?since=${before.cursor}`)).body;
    expect(after.epoch).not.toBe(before.epoch);
    expect((await get('/api/events')).body.events.map((e: { type: string }) => e.type)).toEqual(['runtime_reset']);
  });
});

// ===========================================================================
// E14 reset
// ===========================================================================

describe('E14 POST /api/reset', () => {
  it('200 { epoch } and the data is gone', async () => {
    const d = await newDialog();
    const res = await post('/api/reset', { confirm: 'RESET' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['epoch']);
    expectError(await get(D(d)), 404, 'DIALOG_NOT_FOUND');
    expect((await get('/api/state')).body.dialogs).toEqual([]);
  });

  it('400 on missing or wrong confirm', async () => {
    expectError(await post('/api/reset'), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/reset', { confirm: 'reset' }), 400, 'VALIDATION_ERROR');
    expectError(await post('/api/reset', { confirm: 'RESET', also: 1 }), 400, 'VALIDATION_ERROR');
  });

  it('403 RESET_DISABLED when allowReset is false', async () => {
    await reboot({ allowReset: false });
    const d = await newDialog();
    expectError(await post('/api/reset', { confirm: 'RESET' }), 403, 'RESET_DISABLED');
    expect((await get(D(d))).status).toBe(200);
  });
});

// ===========================================================================
// Lock, malformed JSON, unknown routes, internal errors
// ===========================================================================

describe('409 RUNTIME_BUSY while the lock is held (DECISION 6)', () => {
  it('mutations are refused; reads still work and report busy', async () => {
    const d = await newDialog();
    let release!: () => void;
    const held = rt.withLock(() => new Promise<void>(resolve => { release = resolve; }));

    expectError(await post('/api/dialogs', { task_id: 'T2' }), 409, 'RUNTIME_BUSY');
    expectError(await post(`${D(d)}/requests`, { payload: {} }), 409, 'RUNTIME_BUSY');
    expectError(await post(`${D(d)}/fail`, { reason: 'x' }), 409, 'RUNTIME_BUSY');
    expectError(await post('/api/adapters/A/restart'), 409, 'RUNTIME_BUSY');
    expectError(await post('/api/reset', { confirm: 'RESET' }), 409, 'RUNTIME_BUSY');

    const state = await get('/api/state');
    expect(state.status).toBe(200);
    expect(state.body.runtime.busy).toBe(true);

    release();
    await held;
    expect((await post('/api/dialogs', { task_id: 'T2' })).status).toBe(201);
  });
});

describe('malformed input and unknown routes', () => {
  it('malformed JSON → 400 VALIDATION_ERROR (not 500)', async () => {
    const d = await newDialog();
    for (const url of ['/api/dialogs', `${D(d)}/requests`, '/api/reset']) {
      const res = await postRaw(url, '{"task_id": ');
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.message).toBe('Malformed JSON body');
    }
  });

  it('unknown routes → 404 NOT_FOUND', async () => {
    expectError(await get('/api/nope'), 404, 'NOT_FOUND');
    expectError(await post('/api/nope'), 404, 'NOT_FOUND');
  });

  it('an unexpected error → 500 INTERNAL_SERVER_ERROR without a stack or path', async () => {
    rt.close();
    const res = await get('/api/state');
    expectError(res, 500, 'INTERNAL_SERVER_ERROR');
    expect(res.body.message).toBe('An unexpected error occurred');
  });
});

// ===========================================================================
// Error mapping (§5) — every class, independent of routes
// ===========================================================================

describe('toApiError mapping', () => {
  it('maps each error class to its status and code', () => {
    const zod = z.object({ a: z.string() }).safeParse({});
    const cases: [unknown, number, string][] = [
      [zod.success ? null : zod.error,                         400, 'VALIDATION_ERROR'],
      [Object.assign(new SyntaxError('x'), { type: 'entity.parse.failed', status: 400 }), 400, 'VALIDATION_ERROR'],
      [new ValidationError('bad'),                             400, 'VALIDATION_ERROR'],
      [new NotFoundError('Dialog', 'D1'),                      404, 'DIALOG_NOT_FOUND'],
      [new HttpError(404, 'REQUEST_NOT_FOUND', 'm'),           404, 'REQUEST_NOT_FOUND'],
      [new TaskMismatchError('D1', 'T1', 'T2'),                409, 'TASK_MISMATCH'],
      [new ConflictError('Dialog', 'D1'),                      409, 'CONFLICT'],
      [new InvalidTransitionError('INITIATED', 'COMMITTED'),   409, 'INVALID_TRANSITION'],
      [new DialogTerminalError('D1', 'COMMITTED'),             409, 'DIALOG_TERMINAL'],
      [new RuntimeBusyError(),                                 409, 'RUNTIME_BUSY'],
      [new ResetDisabledError(),                               403, 'RESET_DISABLED'],
      [new AppError('teapot', 'TEAPOT', 418),                  418, 'TEAPOT'],
      [new Error('Dialog not found in Adapter A: dlg-1'),      500, 'INTERNAL_SERVER_ERROR'],
      ['a string',                                             500, 'INTERNAL_SERVER_ERROR'],
    ];
    for (const [err, status, code] of cases) {
      expect(toApiError(err), code).toMatchObject({ status, error: code });
    }
    expect(toApiError(new Error('secret path C:\\x')).message).toBe('An unexpected error occurred');
    expect(toApiError(new HttpError(409, 'PENDING_REQUESTS', 'm', { pending_seqs: [2] })).details)
      .toEqual({ pending_seqs: [2] });
  });
});

// ===========================================================================
// End-to-end flows (§15.1, §15.2)
// ===========================================================================

describe('§15.1 response lost → retry → duplicate → COMMITTED', () => {
  it('runs exactly as documented', async () => {
    const created = await post('/api/dialogs', { task_id: 'task-demo-1' });
    expect(created.status).toBe(201);
    const id = created.body.dialog.dialog_id as string;

    const lost = await post(`${D(id)}/requests`, { payload: { op: 'charge', amount: 42 }, fault: 'drop_response' });
    expect(lost.body).toMatchObject({
      dialog_id: id, task_id: 'task-demo-1', seq: 1, kind: 'send',
      delivery: 'response_dropped', outcome: 'no_answer', response: null,
      send_log: { seq: 1, payload: { op: 'charge', amount: 42 }, status: 'PENDING', attempts: 1 },
      dialog: { state: 'PROCESSING', processed_count: 1, pending_seqs: [1], side_effects_since_boot: 1 },
      dialog_failed: false, events: { from: 2, to: 5 },
    });
    const evs = (await get('/api/events?since=1')).body.events;
    expect(evs.map((e: { type: string; actor: string }) => `${e.type}/${e.actor}`)).toEqual([
      'request_sent/A', 'request_processed/B', 'state_transition/B', 'response_dropped/transport',
    ]);
    expect(evs[3].details).toMatchObject({ b_status: 'ok' });

    const retry = await post(`${D(id)}/requests/1/retry`, {});
    expect(retry.body).toMatchObject({
      seq: 1, kind: 'retry', delivery: 'delivered', outcome: 'duplicate',
      response: { dialog_id: id, task_id: 'task-demo-1', seq: 1, status: 'duplicate',
                  result: { processed: true, payload: { op: 'charge', amount: 42 } } },
      send_log: { seq: 1, status: 'ACKED', attempts: 2 },
      dialog: { processed_count: 1, pending_seqs: [], side_effects_since_boot: 1, duplicates_since_boot: 1 },
      dialog_failed: false, events: { from: 6, to: 9 },
    });

    const done = await post(`${D(id)}/complete`);
    expect(done.body.dialog).toMatchObject({ state: 'COMMITTED', restored: false, terminal: true });

    const blocked = await post(`${D(id)}/requests`, { payload: {} });
    expectError(blocked, 409, 'DIALOG_TERMINAL');
    expect(blocked.body.message).toContain('terminal state COMMITTED');
    const replay = await post(`${D(id)}/requests/1/retry`);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ outcome: 'duplicate', dialog: { state: 'COMMITTED' } });
  });
});

describe('§15.2 Adapter A restart → recover → resume → RECOVERED', () => {
  it('runs exactly as documented', async () => {
    const id = await newDialog('task-demo-5');
    expect((await post(`${D(id)}/requests`, { payload: { step: 1 } })).body).toMatchObject({ outcome: 'ok', seq: 1 });
    expect((await post(`${D(id)}/requests`, { payload: { step: 2 } })).body).toMatchObject({ outcome: 'ok', seq: 2 });
    expect((await post(`${D(id)}/requests`, { payload: { step: 3 }, fault: 'drop_response' })).body)
      .toMatchObject({ delivery: 'response_dropped', seq: 3 });

    const restart = await post('/api/adapters/A/restart');
    expect(restart.body).toEqual({
      target: 'A', scope: 'process', note: 'shared store: both adapter objects rebuilt from the SQLite file',
      recovered: [{ dialog_id: id, task_id: 'task-demo-5', state: 'PROCESSING', next_seq: 4, pending_seqs: [3] }],
    });

    const r3 = await post(`${D(id)}/requests/3/retry`, {});
    expect(r3.body).toMatchObject({
      outcome: 'duplicate', response: { result: { payload: { step: 3 } } },
      dialog: { side_effects_since_boot: 0 },
    });
    const s4 = await post(`${D(id)}/requests`, { payload: { step: 4 } });
    expect(s4.body).toMatchObject({ outcome: 'ok', seq: 4 });

    const done = await post(`${D(id)}/complete`);
    expect(done.body.dialog).toMatchObject({
      dialog_id: id, task_id: 'task-demo-5', state: 'RECOVERED', restored: true,
      terminal: true, processed_count: 4, side_effects_since_boot: 1,
    });
    expect((await get('/api/state')).body.dialogs.filter((x: { task_id: string }) => x.task_id === 'task-demo-5'))
      .toHaveLength(1);
  });
});
