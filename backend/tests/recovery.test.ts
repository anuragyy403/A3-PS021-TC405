/**
 * Phase 3a — Adapter A durable send log and startup recovery.
 *
 * Covers:
 *   - OutboundRequestRepository (PENDING/ACKED log, maxSeq, attempts)
 *   - AdapterA writes the send log before the transport call
 *   - AdapterA.retryRequest replays the stored payload
 *   - AdapterA.recover() rebuilds nextSeq / pending work from disk only
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../src/db/index.js';
import { OutboundRequestRepository } from '../src/repositories/OutboundRequestRepository.js';
import { DialogRepository } from '../src/repositories/DialogRepository.js';
import { NotFoundError } from '../src/errors.js';
import {
  AdapterA,
  AdapterB,
  Transport,
  MessageDroppedError,
  InMemorySideEffectTracker,
} from '../src/adapters/index.js';

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initDb();
});

function tempDbPath(label: string): string {
  return path.join(
    os.tmpdir(),
    `nighthawks-recovery-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`,
  );
}

interface BootedProcess {
  handle:      ReturnType<typeof openDatabase>;
  transport:   Transport;
  sideEffects: InMemorySideEffectTracker;
  adapterA:    AdapterA;
  adapterB:    AdapterB;
}

function boot(file: string): BootedProcess {
  const handle      = openDatabase(file, SQL);
  const transport   = new Transport();
  const sideEffects = new InMemorySideEffectTracker();
  const adapterA    = new AdapterA(handle.db, file, transport);
  const adapterB    = new AdapterB(handle.db, file, transport, sideEffects);
  return { handle, transport, sideEffects, adapterA, adapterB };
}

function shutdown(proc: BootedProcess): void {
  proc.transport.unregisterRequestHandler();
  closeDatabase(proc.handle.db);
}

// ---------------------------------------------------------------------------
// OutboundRequestRepository
// ---------------------------------------------------------------------------

describe('OutboundRequestRepository', () => {
  let handle: ReturnType<typeof openDatabase>;
  let repo:   OutboundRequestRepository;

  beforeEach(() => {
    handle = openDatabase(':memory:', SQL);
    new DialogRepository(handle.db, ':memory:').create({
      dialog_id: 'D1', task_id: 'T1', state: 'INITIATED', restored: false,
    });
    new DialogRepository(handle.db, ':memory:').create({
      dialog_id: 'D2', task_id: 'T2', state: 'INITIATED', restored: false,
    });
    repo = new OutboundRequestRepository(handle.db, ':memory:');
  });

  afterEach(() => closeDatabase(handle.db));

  it('maxSeq is 0 for a dialog with no requests', () => {
    expect(repo.maxSeq('D1')).toBe(0);
  });

  it('recordPending stores a PENDING row with attempts = 1', () => {
    repo.recordPending('D1', 1, '{"a":1}');
    expect(repo.findByKey('D1', 1)).toEqual({
      dialog_id: 'D1', seq: 1, payload: '{"a":1}', status: 'PENDING', attempts: 1,
    });
  });

  it('rejects a second row with the same (dialog_id, seq)', () => {
    repo.recordPending('D1', 1, '{}');
    expect(() => repo.recordPending('D1', 1, '{}')).toThrow();
  });

  it('scopes seq per dialog', () => {
    repo.recordPending('D1', 1, '{}');
    repo.recordPending('D1', 2, '{}');
    repo.recordPending('D2', 1, '{}');
    expect(repo.maxSeq('D1')).toBe(2);
    expect(repo.maxSeq('D2')).toBe(1);
  });

  it('markAcked removes the row from findPending', () => {
    repo.recordPending('D1', 1, '{}');
    repo.recordPending('D1', 2, '{}');
    repo.markAcked('D1', 1);
    expect(repo.findPending('D1').map(r => r.seq)).toEqual([2]);
    expect(repo.findByKey('D1', 1)!.status).toBe('ACKED');
  });

  it('incrementAttempts counts retries', () => {
    repo.recordPending('D1', 1, '{}');
    repo.incrementAttempts('D1', 1);
    repo.incrementAttempts('D1', 1);
    expect(repo.findByKey('D1', 1)!.attempts).toBe(3);
  });

  it('findByKey returns null for an unknown key', () => {
    expect(repo.findByKey('D1', 99)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AdapterA send log behaviour
// ---------------------------------------------------------------------------

describe('AdapterA — durable send log', () => {
  let dbPath: string;
  let proc:   BootedProcess;

  beforeEach(() => {
    dbPath = tempDbPath('sendlog');
    proc = boot(dbPath);
  });

  afterEach(() => {
    shutdown(proc);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  function outbound(): OutboundRequestRepository {
    return new OutboundRequestRepository(proc.handle.db, dbPath);
  }

  it('acknowledged requests are logged as ACKED', async () => {
    const d1 = proc.adapterA.startDialog('T1');
    await proc.adapterA.sendRequest(d1, { op: 'x' });
    expect(outbound().findByKey(d1, 1)).toMatchObject({ status: 'ACKED', attempts: 1 });
  });

  it('a dropped request stays PENDING (logged before the transport call)', async () => {
    const d1 = proc.adapterA.startDialog('T1');
    proc.transport.dropNextRequestMessage();
    await expect(proc.adapterA.sendRequest(d1, {})).rejects.toBeInstanceOf(MessageDroppedError);
    expect(outbound().findByKey(d1, 1)!.status).toBe('PENDING');
    expect(proc.sideEffects.getProcessCount(d1)).toBe(0);
  });

  it('a dropped response stays PENDING even though B processed it', async () => {
    const d1 = proc.adapterA.startDialog('T1');
    proc.transport.dropNextResponseMessage();
    await expect(proc.adapterA.sendRequest(d1, {})).rejects.toBeInstanceOf(MessageDroppedError);
    expect(outbound().findByKey(d1, 1)!.status).toBe('PENDING');
    expect(proc.sideEffects.getProcessCount(d1)).toBe(1);
  });

  it('a lost seq is not reused by the next send', async () => {
    const d1 = proc.adapterA.startDialog('T1');
    proc.transport.dropNextRequestMessage();
    await expect(proc.adapterA.sendRequest(d1, {})).rejects.toThrow();
    const resp = await proc.adapterA.sendRequest(d1, {});
    expect(resp.seq).toBe(2);
  });

  it('retry replays the stored payload and counts the attempt', async () => {
    const d1 = proc.adapterA.startDialog('T1');
    proc.transport.dropNextRequestMessage();
    await expect(proc.adapterA.sendRequest(d1, { amount: 42 })).rejects.toThrow();

    const resp = await proc.adapterA.retryRequest(d1, 1);
    expect(resp.status).toBe('ok');
    expect(resp.result).toMatchObject({ payload: { amount: 42 } });
    expect(outbound().findByKey(d1, 1)).toMatchObject({ status: 'ACKED', attempts: 2 });
  });

  it('retrying a seq that was never sent throws NotFoundError', async () => {
    const d1 = proc.adapterA.startDialog('T1');
    await expect(proc.adapterA.retryRequest(d1, 7)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// AdapterA.recover()
// ---------------------------------------------------------------------------

describe('AdapterA.recover()', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath('recover');
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('returns nothing on a fresh database', () => {
    const proc = boot(dbPath);
    expect(proc.adapterA.recover()).toEqual([]);
    shutdown(proc);
  });

  it('a restarted Adapter A cannot send until it recovers', async () => {
    const before = boot(dbPath);
    const d1 = before.adapterA.startDialog('T1');
    shutdown(before);

    const after = boot(dbPath);
    await expect(after.adapterA.sendRequest(d1, {})).rejects.toThrow(/not found in Adapter A/);
    after.adapterA.recover();
    expect((await after.adapterA.sendRequest(d1, {})).seq).toBe(1);
    shutdown(after);
  });

  it('rebuilds several dialogs independently from disk', async () => {
    const before = boot(dbPath);
    const d1 = before.adapterA.startDialog('T1');  // stays INITIATED, nothing sent
    const d2 = before.adapterA.startDialog('T2');  // seq 1,2 acked
    const d3 = before.adapterA.startDialog('T3');  // seq 1 acked, seq 2 lost

    await before.adapterA.sendRequest(d2, {});
    await before.adapterA.sendRequest(d2, {});
    await before.adapterA.sendRequest(d3, {});
    before.transport.dropNextRequestMessage();
    await expect(before.adapterA.sendRequest(d3, {})).rejects.toThrow();
    shutdown(before);

    const after = boot(dbPath);
    const byId = new Map(after.adapterA.recover().map(r => [r.dialog_id, r]));

    expect(byId.get(d1)).toEqual({
      dialog_id: d1, task_id: 'T1', state: 'INITIATED', nextSeq: 1, pendingSeqs: [],
    });
    expect(byId.get(d2)).toEqual({
      dialog_id: d2, task_id: 'T2', state: 'PROCESSING', nextSeq: 3, pendingSeqs: [],
    });
    expect(byId.get(d3)).toEqual({
      dialog_id: d3, task_id: 'T3', state: 'PROCESSING', nextSeq: 3, pendingSeqs: [2],
    });

    // Every recovered dialog is flagged restored
    for (const id of [d1, d2, d3]) {
      expect(after.adapterA.dialogManager.getDialog(id)!.restored).toBe(true);
    }
    shutdown(after);
  });

  it('does not resume terminal dialogs', async () => {
    const before = boot(dbPath);
    const done   = before.adapterA.startDialog('T-done');
    const active = before.adapterA.startDialog('T-active');
    await before.adapterA.sendRequest(done, {});
    before.adapterA.completeDialog(done);  // PROCESSING → COMMITTED
    shutdown(before);

    const after = boot(dbPath);
    const recovered = after.adapterA.recover();
    expect(recovered.map(r => r.dialog_id)).toEqual([active]);
    expect(after.adapterA.getDialogState(done)).toBeUndefined();
    expect(after.adapterA.dialogManager.getDialog(done)!.restored).toBe(false);
    shutdown(after);
  });

  it('nextSeq survives repeated restarts', async () => {
    let d1 = '';
    for (let round = 1; round <= 3; round++) {
      const proc = boot(dbPath);
      if (round === 1) d1 = proc.adapterA.startDialog('T1');
      else proc.adapterA.recover();

      const resp = await proc.adapterA.sendRequest(d1, { round });
      expect(resp.seq).toBe(round);
      shutdown(proc);
    }
  });
});
