/**
 * Phase 3b — Lifecycle completion and terminal-state protection.
 *
 * Covers:
 *   - AdapterA.completeDialog → COMMITTED (no restart) / RECOVERED (after restart)
 *   - FAILED via retry budget (maxAttempts unanswered attempts) and failDialog
 *   - Adapter A refuses new requests for terminal dialogs
 *   - Adapter B rejects new work for terminal dialogs but still replays
 *     already-processed (dialog_id, seq) as 'duplicate'
 *   - error_code on every 'error' response
 *   - terminal states survive restart and are never resumed by recover()
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../src/db/index.js';
import { OutboundRequestRepository } from '../src/repositories/OutboundRequestRepository.js';
import { RequestRepository } from '../src/repositories/RequestRepository.js';
import {
  ConflictError,
  DialogTerminalError,
  InvalidTransitionError,
  NotFoundError,
} from '../src/errors.js';
import {
  AdapterA,
  AdapterB,
  Transport,
  MessageDroppedError,
  InMemorySideEffectTracker,
  DEFAULT_MAX_ATTEMPTS,
} from '../src/adapters/index.js';
import type { AdapterAOptions } from '../src/adapters/index.js';

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initDb();
});

function tempDbPath(label: string): string {
  return path.join(
    os.tmpdir(),
    `nighthawks-lifecycle-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`,
  );
}

interface BootedProcess {
  handle:      ReturnType<typeof openDatabase>;
  transport:   Transport;
  sideEffects: InMemorySideEffectTracker;
  adapterA:    AdapterA;
  adapterB:    AdapterB;
}

function boot(file: string, options?: AdapterAOptions): BootedProcess {
  const handle      = openDatabase(file, SQL);
  const transport   = new Transport();
  const sideEffects = new InMemorySideEffectTracker();
  const adapterA    = new AdapterA(handle.db, file, transport, options);
  const adapterB    = new AdapterB(handle.db, file, transport, sideEffects);
  return { handle, transport, sideEffects, adapterA, adapterB };
}

function shutdown(proc: BootedProcess): void {
  proc.transport.unregisterRequestHandler();
  closeDatabase(proc.handle.db);
}

let dbPath: string;
let proc:   BootedProcess;

/** (Re)boot the shared process with options; used by budget tests. */
function reboot(options?: AdapterAOptions): void {
  shutdown(proc);
  proc = boot(dbPath, options);
}

beforeEach(() => {
  dbPath = tempDbPath('t');
  proc   = boot(dbPath);
});

afterEach(() => {
  shutdown(proc);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

function stateOf(dialogId: string) {
  return proc.adapterA.dialogManager.getDialog(dialogId)!.state;
}

function outbound(): OutboundRequestRepository {
  return new OutboundRequestRepository(proc.handle.db, dbPath);
}

function processed(): RequestRepository {
  return new RequestRepository(proc.handle.db, dbPath);
}

/** Send one request with the next transport message dropped; expect the drop. */
async function sendDropped(dialogId: string, payload: unknown, drop: 'request' | 'response' = 'request') {
  if (drop === 'request') proc.transport.dropNextRequestMessage();
  else                    proc.transport.dropNextResponseMessage();
  await expect(proc.adapterA.sendRequest(dialogId, payload)).rejects.toBeInstanceOf(MessageDroppedError);
}

async function retryDropped(dialogId: string, seq: number, drop: 'request' | 'response' = 'request') {
  if (drop === 'request') proc.transport.dropNextRequestMessage();
  else                    proc.transport.dropNextResponseMessage();
  await expect(proc.adapterA.retryRequest(dialogId, seq)).rejects.toBeInstanceOf(MessageDroppedError);
}

// ===========================================================================
// Completion
// ===========================================================================

describe('AdapterA.completeDialog', () => {
  it('normal flow → COMMITTED, restored=false, no longer driven', async () => {
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, { step: 1 });
    await proc.adapterA.sendRequest(d, { step: 2 });

    const done = proc.adapterA.completeDialog(d);

    expect(done).toEqual({ dialog_id: d, task_id: 'T1', state: 'COMMITTED', restored: false });
    expect(stateOf(d)).toBe('COMMITTED');
    expect(proc.adapterA.getDialogState(d)).toBeUndefined();
  });

  it('after restart + recover() → RECOVERED, restored=true', async () => {
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, { step: 1 });

    reboot();
    proc.adapterA.recover();
    await proc.adapterA.sendRequest(d, { step: 2 });

    const done = proc.adapterA.completeDialog(d);

    expect(done).toEqual({ dialog_id: d, task_id: 'T1', state: 'RECOVERED', restored: true });
  });

  it('with a PENDING seq → ConflictError, state unchanged', async () => {
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, { step: 1 });
    await sendDropped(d, { step: 2 });

    expect(() => proc.adapterA.completeDialog(d)).toThrow(ConflictError);
    expect(() => proc.adapterA.completeDialog(d)).toThrow(/seq 2 still unanswered/);
    expect(stateOf(d)).toBe('PROCESSING');
    expect(proc.adapterA.getDialogState(d)).toBeDefined();

    // Once the in-flight request is answered, completion succeeds
    await proc.adapterA.retryRequest(d, 2);
    expect(proc.adapterA.completeDialog(d).state).toBe('COMMITTED');
  });

  it('from INITIATED → InvalidTransitionError, state unchanged', () => {
    const d = proc.adapterA.startDialog('T1');

    expect(() => proc.adapterA.completeDialog(d)).toThrow(InvalidTransitionError);
    expect(stateOf(d)).toBe('INITIATED');
    expect(proc.adapterA.getDialogState(d)).toBeDefined();
  });

  it('from INITIATED after restart → InvalidTransitionError (not RECOVERED)', () => {
    const d = proc.adapterA.startDialog('T1');
    reboot();
    proc.adapterA.recover();

    expect(() => proc.adapterA.completeDialog(d)).toThrow(InvalidTransitionError);
    expect(stateOf(d)).toBe('INITIATED');
  });

  it('twice → second call throws (dialog no longer driven)', async () => {
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, {});
    proc.adapterA.completeDialog(d);

    expect(() => proc.adapterA.completeDialog(d)).toThrow(/not found in Adapter A/);
    expect(stateOf(d)).toBe('COMMITTED');
  });
});

// ===========================================================================
// FAILED — retry budget
// ===========================================================================

describe('Retry budget → FAILED', () => {
  it('request dropped maxAttempts times → dialog FAILED, error rethrown', async () => {
    reboot({ maxAttempts: 3 });
    const d = proc.adapterA.startDialog('T1');

    await sendDropped(d, { op: 'x' });   // attempt 1
    await retryDropped(d, 1);            // attempt 2
    expect(stateOf(d)).toBe('INITIATED');  // budget not yet exhausted

    await retryDropped(d, 1);            // attempt 3 → budget exhausted

    expect(stateOf(d)).toBe('FAILED');
    expect(outbound().findByKey(d, 1)).toMatchObject({ status: 'PENDING', attempts: 3 });
    expect(proc.adapterA.getDialogState(d)).toBeUndefined();
    expect(proc.sideEffects.getProcessCount(d)).toBe(0);
  });

  it('fails a PROCESSING dialog too', async () => {
    reboot({ maxAttempts: 2 });
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, { step: 1 });

    await sendDropped(d, { step: 2 });
    await retryDropped(d, 2);

    expect(stateOf(d)).toBe('FAILED');
  });

  it('default budget is DEFAULT_MAX_ATTEMPTS (5)', async () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
    const d = proc.adapterA.startDialog('T1');

    await sendDropped(d, {});
    for (let i = 2; i < DEFAULT_MAX_ATTEMPTS; i++) await retryDropped(d, 1);
    expect(stateOf(d)).toBe('INITIATED');  // 4 unanswered attempts

    await retryDropped(d, 1);              // 5th
    expect(stateOf(d)).toBe('FAILED');
  });

  it('lost responses count as unanswered; the processed seq still replays as duplicate', async () => {
    reboot({ maxAttempts: 2 });
    const d = proc.adapterA.startDialog('T1');

    await sendDropped(d, { op: 'charge' }, 'response');  // B processed it
    await retryDropped(d, 1, 'response');                // duplicate at B, answer lost again
    expect(stateOf(d)).toBe('FAILED');
    expect(proc.sideEffects.getProcessCount(d)).toBe(1);

    // Idempotent replay on the FAILED dialog: stored result, no state change
    const replay = await proc.adapterA.retryRequest(d, 1);
    expect(replay.status).toBe('duplicate');
    expect(replay.result).toMatchObject({ payload: { op: 'charge' } });
    expect(stateOf(d)).toBe('FAILED');
    expect(proc.sideEffects.getProcessCount(d)).toBe(1);
  });

  it('acked seq retried more than maxAttempts times → dialog NOT failed', async () => {
    reboot({ maxAttempts: 2 });
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, { step: 1 });  // ACKED

    // Plain duplicate replays
    for (let i = 0; i < 4; i++) {
      expect((await proc.adapterA.retryRequest(d, 1)).status).toBe('duplicate');
    }
    // Even dropped replays of an already-answered request do not count
    await retryDropped(d, 1);
    await retryDropped(d, 1, 'response');

    expect(outbound().findByKey(d, 1)).toMatchObject({ status: 'ACKED' });
    expect(outbound().findByKey(d, 1)!.attempts).toBeGreaterThan(2);
    expect(stateOf(d)).toBe('PROCESSING');
    expect(proc.adapterA.completeDialog(d).state).toBe('COMMITTED');
  });

  it('rejects a non-positive maxAttempts', () => {
    expect(() => new AdapterA(proc.handle.db, dbPath, new Transport(), { maxAttempts: 0 }))
      .toThrow(RangeError);
  });
});

// ===========================================================================
// FAILED — explicit abort
// ===========================================================================

describe('AdapterA.failDialog', () => {
  it('INITIATED → FAILED', () => {
    const d = proc.adapterA.startDialog('T1');

    const failed = proc.adapterA.failDialog(d, 'user cancelled');

    expect(failed).toEqual({ dialog_id: d, task_id: 'T1', state: 'FAILED', restored: false });
    expect(proc.adapterA.getDialogState(d)).toBeUndefined();
  });

  it('PROCESSING → FAILED', async () => {
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, {});

    expect(proc.adapterA.failDialog(d, 'upstream error').state).toBe('FAILED');
    expect(stateOf(d)).toBe('FAILED');
  });

  it('cannot fail a dialog that already finished', async () => {
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, {});
    proc.adapterA.completeDialog(d);

    expect(() => proc.adapterA.failDialog(d, 'too late')).toThrow();
    expect(stateOf(d)).toBe('COMMITTED');
  });
});

// ===========================================================================
// Terminal guard — Adapter A
// ===========================================================================

describe('Terminal guard — Adapter A', () => {
  /** Drive a fresh dialog to the requested terminal state. */
  async function terminalDialog(state: 'COMMITTED' | 'RECOVERED' | 'FAILED'): Promise<string> {
    const d = proc.adapterA.startDialog(`T-${state}`);
    await proc.adapterA.sendRequest(d, { step: 1 });

    if (state === 'COMMITTED') proc.adapterA.completeDialog(d);
    if (state === 'FAILED')    proc.adapterA.failDialog(d, 'test');
    if (state === 'RECOVERED') {
      reboot();
      proc.adapterA.recover();
      proc.adapterA.completeDialog(d);
    }
    expect(stateOf(d)).toBe(state);
    return d;
  }

  for (const state of ['COMMITTED', 'RECOVERED', 'FAILED'] as const) {
    it(`sendRequest on a ${state} dialog throws before writing a PENDING row`, async () => {
      const d = await terminalDialog(state);
      const before = outbound().maxSeq(d);

      const attempt = proc.adapterA.sendRequest(d, { step: 2 });
      await expect(attempt).rejects.toBeInstanceOf(DialogTerminalError);
      await expect(proc.adapterA.sendRequest(d, {})).rejects.toThrow(`terminal state ${state}`);

      expect(outbound().maxSeq(d)).toBe(before);
      expect(outbound().findByKey(d, before + 1)).toBeNull();
      expect(stateOf(d)).toBe(state);
    });

    it(`retryRequest on a ${state} dialog replays a logged seq without changing state`, async () => {
      const d = await terminalDialog(state);

      const replay = await proc.adapterA.retryRequest(d, 1);
      expect(replay.status).toBe('duplicate');
      expect(replay.result).toMatchObject({ payload: { step: 1 } });
      expect(stateOf(d)).toBe(state);

      await expect(proc.adapterA.retryRequest(d, 2)).rejects.toBeInstanceOf(NotFoundError);
    });
  }
});

// ===========================================================================
// Terminal guard — Adapter B (hand-built requests straight to the transport)
// ===========================================================================

describe('Terminal guard — Adapter B', () => {
  for (const state of ['COMMITTED', 'FAILED'] as const) {
    it(`new seq on a ${state} dialog → DIALOG_TERMINAL, no side effect, no record`, async () => {
      const d = proc.adapterA.startDialog('T1');
      await proc.adapterA.sendRequest(d, { step: 1 });
      if (state === 'COMMITTED') proc.adapterA.completeDialog(d);
      else                       proc.adapterA.failDialog(d, 'test');

      const countBefore = proc.sideEffects.getProcessCount(d);
      const resp = await proc.transport.sendRequest({
        dialog_id: d, task_id: 'T1', seq: 2, payload: { sneaky: true },
      });

      expect(resp.status).toBe('error');
      expect(resp.error_code).toBe('DIALOG_TERMINAL');
      expect(resp.error).toContain(state);
      expect(proc.sideEffects.getProcessCount(d)).toBe(countBefore);
      expect(processed().findByKey(d, 2)).toBeNull();
      expect(stateOf(d)).toBe(state);
    });

    it(`already-processed seq on a ${state} dialog → duplicate with stored result`, async () => {
      const d = proc.adapterA.startDialog('T1');
      const first = await proc.adapterA.sendRequest(d, { step: 1 });
      if (state === 'COMMITTED') proc.adapterA.completeDialog(d);
      else                       proc.adapterA.failDialog(d, 'test');

      const resp = await proc.transport.sendRequest({
        dialog_id: d, task_id: 'T1', seq: 1, payload: { step: 1 },
      });

      expect(resp.status).toBe('duplicate');
      expect(resp.error_code).toBeUndefined();
      expect(resp.result).toEqual(first.result);
      expect(proc.sideEffects.getProcessCount(d)).toBe(1);
      expect(stateOf(d)).toBe(state);
    });
  }

  it('task_id is still verified before the duplicate replay', async () => {
    const d = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d, {});
    proc.adapterA.completeDialog(d);

    const resp = await proc.transport.sendRequest({ dialog_id: d, task_id: 'T-other', seq: 1, payload: {} });
    expect(resp.status).toBe('error');
    expect(resp.error_code).toBe('TASK_MISMATCH');
  });
});

// ===========================================================================
// error_code values
// ===========================================================================

describe('AdapterResponse.error_code', () => {
  it('unknown dialog → DIALOG_NOT_FOUND', async () => {
    const resp = await proc.transport.sendRequest({ dialog_id: 'dlg-nope', task_id: 'T1', seq: 1, payload: {} });
    expect(resp).toMatchObject({ status: 'error', error_code: 'DIALOG_NOT_FOUND' });
    expect(resp.error).toContain('not found');
  });

  it('task_id mismatch → TASK_MISMATCH', async () => {
    const d = proc.adapterA.startDialog('T1');
    const resp = await proc.transport.sendRequest({ dialog_id: d, task_id: 'T2', seq: 1, payload: {} });
    expect(resp).toMatchObject({ status: 'error', error_code: 'TASK_MISMATCH' });
    expect(resp.error).toContain('mismatch');
    expect(stateOf(d)).toBe('INITIATED');
  });

  it('ok and duplicate responses carry no error_code', async () => {
    const d = proc.adapterA.startDialog('T1');
    expect((await proc.adapterA.sendRequest(d, {})).error_code).toBeUndefined();
    expect((await proc.adapterA.retryRequest(d, 1)).error_code).toBeUndefined();
  });
});

// ===========================================================================
// Terminal states across restart
// ===========================================================================

describe('Terminal states survive restart', () => {
  it('COMMITTED / RECOVERED / FAILED reload unchanged and are not resumed', async () => {
    const committed = proc.adapterA.startDialog('T-c');
    const failed    = proc.adapterA.startDialog('T-f');
    const recovered = proc.adapterA.startDialog('T-r');
    const active    = proc.adapterA.startDialog('T-a');

    await proc.adapterA.sendRequest(committed, {});
    proc.adapterA.completeDialog(committed);
    await proc.adapterA.sendRequest(failed, {});
    proc.adapterA.failDialog(failed, 'test');
    await proc.adapterA.sendRequest(recovered, {});
    await proc.adapterA.sendRequest(active, {});

    // First restart: `recovered` finishes after recovery
    reboot();
    expect(proc.adapterA.recover().map(r => r.dialog_id).sort()).toEqual([active, recovered].sort());
    proc.adapterA.completeDialog(recovered);

    // Second restart: reopen the file, nothing in memory
    reboot();
    const dm = proc.adapterA.dialogManager;
    expect(dm.getDialog(committed)).toMatchObject({ state: 'COMMITTED', restored: false });
    expect(dm.getDialog(failed)).toMatchObject({ state: 'FAILED', restored: false });
    expect(dm.getDialog(recovered)).toMatchObject({ state: 'RECOVERED', restored: true });

    // recover() resumes only the still-active dialog
    expect(proc.adapterA.recover().map(r => r.dialog_id)).toEqual([active]);
    for (const id of [committed, failed, recovered]) {
      expect(proc.adapterA.getDialogState(id)).toBeUndefined();
    }

    // Adapter B still refuses new work for them after the restart
    for (const [id, task] of [[committed, 'T-c'], [failed, 'T-f'], [recovered, 'T-r']] as const) {
      const resp = await proc.transport.sendRequest({ dialog_id: id, task_id: task, seq: 99, payload: {} });
      expect(resp.error_code).toBe('DIALOG_TERMINAL');
    }
    expect(proc.sideEffects.getProcessCount(committed)).toBe(0);
  });
});
