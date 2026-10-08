/**
 * Phase 6a — SimulationRuntime (docs/API_DESIGN.md §1, §4, §7, §9, §10).
 *
 * Every test uses a real SQLite FILE in its own temp directory, so restarts
 * genuinely reopen the file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';

import { SimulationRuntime, RESTART_NOTE } from '../src/runtime/SimulationRuntime.js';
import type { RuntimeConfig, SendResult } from '../src/runtime/SimulationRuntime.js';
import {
  DialogTerminalError,
  NotFoundError,
  ResetDisabledError,
  RuntimeBusyError,
} from '../src/errors.js';

let dir: string;
let rt: SimulationRuntime | null;

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    dbPath:          path.join(dir, 'runtime.db'),
    maxAttempts:     5,
    allowReset:      true,
    eventBufferSize: 1000,
    ...over,
  };
}

async function boot(over: Partial<RuntimeConfig> = {}): Promise<SimulationRuntime> {
  rt = await SimulationRuntime.create(cfg(over));
  return rt;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nighthawks-runtime-'));
  rt  = null;
});

afterEach(() => {
  rt?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function types(r: SimulationRuntime, since = 0): string[] {
  return r.events(since, 500).events.map(e => e.type);
}

// ===========================================================================
// Boot
// ===========================================================================

describe('boot', () => {
  it('on an empty DB: no dialogs, no events, zero metrics', async () => {
    const r = await boot();
    const s = r.getState();

    expect(s.dialogs).toEqual([]);
    expect(r.events().events).toEqual([]);
    expect(s.metrics).toMatchObject({
      processed_count: 0, transport_attempts: 0, dialogs_total: 0, restored_total: 0,
      side_effects_since_boot: 0, duplicates_since_boot: 0, drops_since_boot: 0, restart_count: 0,
      by_state: { INITIATED: 0, PROCESSING: 0, COMMITTED: 0, RECOVERED: 0, FAILED: 0 },
    });
    expect(s.runtime).toMatchObject({ db_path_name: 'runtime.db', max_attempts: 5, busy: false, cursor: 0 });
    expect(s.nodes.adapterA.status).toBe('online');
  });

  it('on an existing DB: recovers active dialogs and emits dialog_recovered', async () => {
    const first = await boot();
    const active = (await first.startDialog('T-active')).dialog_id;
    await first.send(active, { step: 1 });
    await first.send(active, { step: 2 }, 'drop_request');
    const done = (await first.startDialog('T-done')).dialog_id;
    await first.send(done, {});
    await first.complete(done);
    first.close();

    const second = await boot();
    expect(second.events().events).toEqual([
      expect.objectContaining({
        type: 'dialog_recovered', actor: 'A', dialog_id: active, task_id: 'T-active',
        details: { state: 'PROCESSING', next_seq: 3, pending_seqs: [2] },
      }),
    ]);
    expect(second.getDialog(active).dialog).toMatchObject({ restored: true, next_seq: 3, pending_seqs: [2] });
    expect(second.getDialog(done).dialog).toMatchObject({ state: 'COMMITTED', restored: false });

    // The recovered dialog is driven again: it can continue
    expect((await second.send(active, { step: 3 })).seq).toBe(3);
  });
});

// ===========================================================================
// Send / retry outcomes (§4)
// ===========================================================================

describe('send / retry outcomes', () => {
  it('ok', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;

    const res = await r.send(d, { op: 'charge' });

    expect(res).toMatchObject({
      dialog_id: d, task_id: 'T1', seq: 1, kind: 'send',
      delivery: 'delivered', outcome: 'ok', dialog_failed: false,
      send_log: { seq: 1, payload: { op: 'charge' }, status: 'ACKED', attempts: 1 },
      dialog:   { state: 'PROCESSING', processed_count: 1, pending_seqs: [], side_effects_since_boot: 1 },
    });
    expect(res.response).toMatchObject({ status: 'ok', result: { processed: true, payload: { op: 'charge' } } });
    expect(res.error_code).toBeUndefined();
  });

  it('duplicate (retry of a processed seq)', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    const first = await r.send(d, { op: 'charge' });

    const res = await r.retry(d, 1);

    expect(res).toMatchObject({
      seq: 1, kind: 'retry', delivery: 'delivered', outcome: 'duplicate',
      send_log: { status: 'ACKED', attempts: 2 },
      dialog:   { processed_count: 1, side_effects_since_boot: 1, duplicates_since_boot: 1 },
    });
    expect(res.response!.result).toEqual(first.response!.result);
  });

  it('request_dropped → no_answer, PENDING, nothing processed', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;

    const res = await r.send(d, { op: 'x' }, 'drop_request');

    expect(res).toMatchObject({
      seq: 1, delivery: 'request_dropped', outcome: 'no_answer', response: null, dialog_failed: false,
      send_log: { status: 'PENDING', attempts: 1 },
      dialog:   { state: 'INITIATED', processed_count: 0, pending_seqs: [1] },
    });
  });

  it('response_dropped → no_answer, PENDING, but B processed it', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;

    const res = await r.send(d, { op: 'x' }, 'drop_response');

    expect(res).toMatchObject({
      seq: 1, delivery: 'response_dropped', outcome: 'no_answer', response: null,
      send_log: { status: 'PENDING' },
      dialog:   { state: 'PROCESSING', processed_count: 1, pending_seqs: [1], side_effects_since_boot: 1 },
    });
    expect(r.getDialog(d).ledger).toEqual([{ seq: 1, status: 'processed_unacked', attempts: 1 }]);
  });

  it('rejected → error_code (retry of an unprocessed seq on a FAILED dialog)', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, {}, 'drop_request');
    await r.fail(d, 'operator abort');

    const res = await r.retry(d, 1);

    expect(res).toMatchObject({
      delivery: 'delivered', outcome: 'rejected', error_code: 'DIALOG_TERMINAL',
      send_log: { status: 'PENDING', attempts: 2 },
      dialog:   { state: 'FAILED' },
      dialog_failed: false,
    });
    expect(res.response).toMatchObject({ status: 'error', error_code: 'DIALOG_TERMINAL' });
  });

  it('retry budget exhausted → dialog_failed, FAILED, A-side state_transition', async () => {
    const r = await boot({ maxAttempts: 2 });
    const d = (await r.startDialog('T1')).dialog_id;

    const first = await r.send(d, {}, 'drop_request');
    expect(first.dialog_failed).toBe(false);

    const second = await r.retry(d, 1, 'drop_request');
    expect(second).toMatchObject({
      delivery: 'request_dropped', outcome: 'no_answer', dialog_failed: true,
      dialog: { state: 'FAILED', terminal: true },
      send_log: { attempts: 2, status: 'PENDING' },
    });

    const transition = r.events(second.events.from - 1).events.find(e => e.type === 'state_transition');
    expect(transition).toMatchObject({
      actor: 'A', outcome: 'FAILED',
      details: { from: 'INITIATED', to: 'FAILED', reason: 'retry budget exhausted (attempts 2)' },
    });
  });

  it('retry budget after B processed (response lost twice): from PROCESSING', async () => {
    const r = await boot({ maxAttempts: 2 });
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, {}, 'drop_response');
    const res = await r.retry(d, 1, 'drop_response');

    expect(res).toMatchObject({ dialog_failed: true, delivery: 'response_dropped', dialog: { state: 'FAILED' } });
    const transitions = r.events().events.filter(e => e.type === 'state_transition');
    expect(transitions.map(e => [e.actor, e.details?.['from'], e.details?.['to']])).toEqual([
      ['B', 'INITIATED', 'PROCESSING'],
      ['A', 'PROCESSING', 'FAILED'],
    ]);
  });

  it('a fault never leaks into the following call', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, {}, 'drop_response');
    const next = await r.send(d, {});
    expect(next).toMatchObject({ seq: 2, delivery: 'delivered', outcome: 'ok' });
  });
});

// ===========================================================================
// Completion, failure, pre-checks
// ===========================================================================

describe('complete / fail / pre-checks', () => {
  it('complete → COMMITTED; restart then complete → RECOVERED', async () => {
    const r = await boot();
    const a = (await r.startDialog('T-a')).dialog_id;
    const b = (await r.startDialog('T-b')).dialog_id;
    await r.send(a, {});
    await r.send(b, {});

    expect(await r.complete(a)).toMatchObject({ state: 'COMMITTED', restored: false, terminal: true });

    await r.restart('A');
    expect(await r.complete(b)).toMatchObject({ state: 'RECOVERED', restored: true, terminal: true });
  });

  it('fail → FAILED with reason in the event', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    expect(await r.fail(d, 'operator abort')).toMatchObject({ state: 'FAILED' });
    expect(r.events().events.at(-1)).toMatchObject({
      type: 'state_transition', actor: 'A',
      details: { from: 'INITIATED', to: 'FAILED', reason: 'failDialog: operator abort' },
    });
  });

  it('complete / fail / send on a terminal dialog → DialogTerminalError', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, {});
    await r.complete(d);

    await expect(r.complete(d)).rejects.toBeInstanceOf(DialogTerminalError);
    await expect(r.fail(d, 'x')).rejects.toBeInstanceOf(DialogTerminalError);
    await expect(r.send(d, {})).rejects.toBeInstanceOf(DialogTerminalError);
    expect(r.getDialog(d).send_log).toHaveLength(1);   // no PENDING row written
  });

  it('terminal after restart (not driven by the new Adapter A) → DialogTerminalError, not a plain Error', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, {});
    await r.complete(d);
    await r.restart('B');

    await expect(r.complete(d)).rejects.toBeInstanceOf(DialogTerminalError);
    await expect(r.fail(d, 'x')).rejects.toBeInstanceOf(DialogTerminalError);
  });

  it('unknown dialog → NotFoundError; unknown seq on retry → NotFoundError', async () => {
    const r = await boot();
    await expect(r.send('dlg-nope', {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.retry('dlg-nope', 1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.complete('dlg-nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(r.fail('dlg-nope', 'x')).rejects.toBeInstanceOf(NotFoundError);
    expect(() => r.getDialog('dlg-nope')).toThrow(NotFoundError);

    const d = (await r.startDialog('T1')).dialog_id;
    await expect(r.retry(d, 7)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('retry on a terminal dialog is an idempotent replay (state unchanged)', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, {});
    await r.complete(d);

    expect(await r.retry(d, 1)).toMatchObject({ outcome: 'duplicate', dialog: { state: 'COMMITTED' } });
  });
});

// ===========================================================================
// Restart (§1)
// ===========================================================================

describe('restart', () => {
  it('reads from the FILE: unpersisted in-memory changes are gone', async () => {
    const r = await boot();
    const d = (await r.startDialog('T-original')).dialog_id;
    await r.send(d, {});

    // Tamper with the live in-memory database WITHOUT persisting to disk.
    r.database.run(`UPDATE dialogs SET task_id = 'tampered' WHERE dialog_id = ?`, [d]);
    expect(r.getDialog(d).dialog.task_id).toBe('tampered');

    await r.restart('B');
    expect(r.getDialog(d).dialog.task_id).toBe('T-original');
  });

  it('result and events: scope "process", note, recovered list, begin/end', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, {}, 'drop_response');
    const cursor = r.events().cursor;

    const res = await r.restart('B');

    expect(res).toEqual({
      target: 'B', scope: 'process', note: RESTART_NOTE,
      recovered: [{ dialog_id: d, task_id: 'T1', state: 'PROCESSING', next_seq: 2, pending_seqs: [1] }],
    });
    const evs = r.events(cursor).events;
    expect(evs.map(e => e.type)).toEqual(['adapter_restarted', 'dialog_recovered', 'adapter_restarted']);
    expect(evs[0]!.details).toEqual({ target: 'B', scope: 'process', note: RESTART_NOTE, phase: 'begin' });
    expect(evs[2]!.details).toMatchObject({ phase: 'end' });
    expect(r.getState().runtime.restart_count).toBe(1);
  });

  it('counters: durable ones survive, side_effects_since_boot resets, invariants hold', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, { step: 1 });
    await r.send(d, { step: 2 }, 'drop_response');
    await r.retry(d, 2);                               // duplicate

    const before = r.getMetrics();
    expect(before).toMatchObject({
      processed_count: 2, transport_attempts: 3, side_effects_since_boot: 2,
      duplicates_since_boot: 1, drops_since_boot: 1,
    });

    await r.restart('A');
    const after = r.getMetrics();
    expect(after).toMatchObject({
      processed_count: 2, transport_attempts: 3, side_effects_since_boot: 0,
      duplicates_since_boot: 1, drops_since_boot: 1, restored_total: 1,
    });

    await r.retry(d, 1);                               // duplicate after restart: nothing re-run
    await r.send(d, { step: 3 });
    const end = r.getMetrics();
    expect(end).toMatchObject({ processed_count: 3, transport_attempts: 5, side_effects_since_boot: 1 });

    for (const m of [before, after, end]) {
      expect(m.processed_count).toBeLessThanOrEqual(m.transport_attempts);
      expect(m.side_effects_since_boot).toBeLessThanOrEqual(m.processed_count);
    }
  });
});

// ===========================================================================
// Lock (§9)
// ===========================================================================

describe('lock', () => {
  it('a second mutation while one is in progress → RuntimeBusyError; reads still work', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;

    const inFlight = r.send(d, {});            // takes the lock synchronously
    expect(r.busy).toBe(true);
    expect(r.getState().runtime.busy).toBe(true);
    await expect(r.startDialog('T2')).rejects.toBeInstanceOf(RuntimeBusyError);
    await expect(r.restart('A')).rejects.toBeInstanceOf(RuntimeBusyError);

    expect((await inFlight).outcome).toBe('ok');
    expect(r.busy).toBe(false);
    await expect(r.startDialog('T2')).resolves.toMatchObject({ task_id: 'T2' });
  });

  it('the lock is released when the operation throws', async () => {
    const r = await boot();
    await expect(r.send('dlg-nope', {})).rejects.toBeInstanceOf(NotFoundError);
    expect(r.busy).toBe(false);
  });

  it('withLock gives several steps one lock', async () => {
    const r = await boot();
    const result = await r.withLock(async ops => {
      const d = (await ops.startDialog('T1')).dialog_id;
      await ops.send(d, {});
      await expect(r.startDialog('T2')).rejects.toBeInstanceOf(RuntimeBusyError);
      return ops.complete(d);
    });
    expect(result.state).toBe('COMMITTED');
  });
});

// ===========================================================================
// Reset (§10)
// ===========================================================================

describe('reset', () => {
  it('deletes only dbPath, clears data and events, new epoch, runtime_reset event', async () => {
    const r = await boot();
    const sibling = path.join(dir, 'keep-me.db');
    fs.writeFileSync(sibling, 'not touched');
    const d = (await r.startDialog('T1')).dialog_id;
    await r.send(d, {}, 'drop_request');
    const epoch1 = r.getState().runtime.epoch;

    const res = await r.reset();

    expect(res.epoch).not.toBe(epoch1);
    expect(fs.readFileSync(sibling, 'utf8')).toBe('not touched');
    expect(r.getState().dialogs).toEqual([]);
    expect(r.getMetrics()).toMatchObject({ transport_attempts: 0, drops_since_boot: 0, restart_count: 0 });
    const page = r.events(0);
    expect(page.epoch).toBe(res.epoch);
    expect(page.events.map(e => e.type)).toEqual(['runtime_reset']);
    expect(() => r.getDialog(d)).toThrow(NotFoundError);
  });

  it('disabled → ResetDisabledError, data intact', async () => {
    const r = await boot({ allowReset: false });
    const d = (await r.startDialog('T1')).dialog_id;
    await expect(r.reset()).rejects.toBeInstanceOf(ResetDisabledError);
    expect(r.getDialog(d).dialog.task_id).toBe('T1');
  });

  it('refuses a path that does not end in .db', async () => {
    const r = await boot({ dbPath: path.join(dir, 'state.sqlite') });
    await r.startDialog('T1');
    await expect(r.reset()).rejects.toBeInstanceOf(ResetDisabledError);
    expect(fs.existsSync(path.join(dir, 'state.sqlite'))).toBe(true);
  });
});

// ===========================================================================
// Events for one response-lost-then-retry flow
// ===========================================================================

describe('events', () => {
  it('response lost, then retry: exact event sequence and per-call ranges', async () => {
    const r = await boot();
    const d = (await r.startDialog('T1')).dialog_id;
    const lost:  SendResult = await r.send(d, { op: 'charge' }, 'drop_response');
    const retry: SendResult = await r.retry(d, 1);

    expect(types(r)).toEqual([
      'dialog_created',
      // send (response dropped)
      'request_sent', 'request_processed', 'state_transition', 'response_dropped',
      // retry
      'retry_sent', 'duplicate_suppressed', 'response_delivered', 'request_acked',
    ]);
    expect(lost.events).toEqual({ from: 2, to: 5 });
    expect(retry.events).toEqual({ from: 6, to: 9 });

    const all = r.events().events;
    expect(all.every(e => e.dialog_id === d && e.task_id === 'T1')).toBe(true);
    expect(all.slice(1).every(e => e.seq === 1)).toBe(true);
    expect(all[5]).toMatchObject({ actor: 'A', details: { attempts: 2, send_log_status: 'PENDING' } });
  });
});
