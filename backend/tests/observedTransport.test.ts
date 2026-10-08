/**
 * Phase 6a — ObservedTransport (docs/API_DESIGN.md §3, §6.4).
 *
 * Uses the real AdapterA / AdapterB over an in-memory database so the events
 * reflect real adapter behaviour, plus a stub handler for the throw cases.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../src/db/index.js';
import { AdapterA, AdapterB, InMemorySideEffectTracker, MessageDroppedError } from '../src/adapters/index.js';
import type { AdapterRequest } from '../src/adapters/index.js';
import { DialogRepository } from '../src/repositories/DialogRepository.js';
import { RequestRepository } from '../src/repositories/RequestRepository.js';
import { EventLog } from '../src/runtime/EventLog.js';
import type { ApiEvent } from '../src/runtime/EventLog.js';
import { ObservedTransport } from '../src/runtime/ObservedTransport.js';
import type { TransportObserver } from '../src/runtime/ObservedTransport.js';

let SQL: SqlJsStatic;
let handle: ReturnType<typeof openDatabase>;
let log: EventLog;
let tracker: InMemorySideEffectTracker;
let transport: ObservedTransport;
let adapterA: AdapterA;

beforeAll(async () => {
  SQL = await initDb();
});

function observer(): TransportObserver {
  const dialogs  = new DialogRepository(handle.db, ':memory:');
  const requests = new RequestRepository(handle.db, ':memory:');
  return {
    emit:                 e  => log.append(e),
    dialogState:          id => dialogs.findById(id)?.state ?? null,
    processedCount:       id => requests.countPerDialog().get(id) ?? 0,
    sideEffectsSinceBoot: id => tracker.getProcessCount(id),
  };
}

beforeEach(() => {
  handle    = openDatabase(':memory:', SQL);
  log       = new EventLog(100);
  tracker   = new InMemorySideEffectTracker();
  transport = new ObservedTransport(observer());
  new AdapterB(handle.db, ':memory:', transport, tracker);
  adapterA  = new AdapterA(handle.db, ':memory:', transport);
});

afterEach(() => closeDatabase(handle.db));

function types(events: ApiEvent[] = log.since(0, 500).events): string[] {
  return events.map(e => e.type);
}

describe('ObservedTransport — events', () => {
  it('first request: request_processed, B state_transition, response_delivered', async () => {
    const d = adapterA.startDialog('T1');
    const resp = await transport.withFault(undefined, () => adapterA.sendRequest(d, { x: 1 }));

    expect(resp.status).toBe('ok');
    expect(types()).toEqual(['request_processed', 'state_transition', 'response_delivered']);

    const [processed, transition, delivered] = log.since(0).events;
    expect(processed).toMatchObject({
      actor: 'B', dialog_id: d, task_id: 'T1', seq: 1, outcome: 'ok',
      details: { processed_count: 1, side_effects_since_boot: 1 },
    });
    expect(transition).toMatchObject({
      actor: 'B', outcome: 'PROCESSING',
      details: { from: 'INITIATED', to: 'PROCESSING', reason: 'first request processed' },
    });
    expect(delivered).toMatchObject({ actor: 'transport', outcome: 'ok', details: { status: 'ok' } });
    expect(transport.lastCall).toMatchObject({ delivery: 'delivered', stateAfterB: 'PROCESSING' });
  });

  it('second request: no further state_transition', async () => {
    const d = adapterA.startDialog('T1');
    await adapterA.sendRequest(d, {});
    const cursor = log.latestId;
    await adapterA.sendRequest(d, {});
    expect(types(log.since(cursor).events)).toEqual(['request_processed', 'response_delivered']);
  });

  it('duplicate: duplicate_suppressed (terminal flag) then response_delivered', async () => {
    const d = adapterA.startDialog('T1');
    await adapterA.sendRequest(d, {});
    const cursor = log.latestId;

    await adapterA.retryRequest(d, 1);
    expect(types(log.since(cursor).events)).toEqual(['duplicate_suppressed', 'response_delivered']);
    expect(log.since(cursor).events[0]).toMatchObject({
      actor: 'B', outcome: 'duplicate', details: { terminal: false },
    });

    adapterA.completeDialog(d);
    const c2 = log.latestId;
    await adapterA.retryRequest(d, 1);
    expect(log.since(c2).events[0]).toMatchObject({ type: 'duplicate_suppressed', details: { terminal: true } });
  });

  it('rejected: request_rejected carries error_code', async () => {
    const d = adapterA.startDialog('T1');
    const resp = await transport.sendRequest({ dialog_id: d, task_id: 'WRONG', seq: 1, payload: {} });

    expect(resp.status).toBe('error');
    expect(types()).toEqual(['request_rejected', 'response_delivered']);
    expect(log.since(0).events[0]).toMatchObject({
      actor: 'B', outcome: 'rejected', details: { error_code: 'TASK_MISMATCH' },
    });
  });

  it('drop_request: request_dropped only; B never ran', async () => {
    const d = adapterA.startDialog('T1');
    await expect(
      transport.withFault('drop_request', () => adapterA.sendRequest(d, {})),
    ).rejects.toBeInstanceOf(MessageDroppedError);

    expect(types()).toEqual(['request_dropped']);
    expect(log.since(0).events[0]).toMatchObject({
      actor: 'transport', dialog_id: d, seq: 1, details: { fault: 'drop_request' },
    });
    expect(transport.lastCall).toEqual({ delivery: 'request_dropped', bResponse: null, stateAfterB: null });
    expect(tracker.getProcessCount(d)).toBe(0);
  });

  it('drop_response: B events, then response_dropped with B status', async () => {
    const d = adapterA.startDialog('T1');
    await expect(
      transport.withFault('drop_response', () => adapterA.sendRequest(d, {})),
    ).rejects.toBeInstanceOf(MessageDroppedError);

    expect(types()).toEqual(['request_processed', 'state_transition', 'response_dropped']);
    expect(log.since(0).events[2]).toMatchObject({
      actor: 'transport', details: { fault: 'drop_response', b_status: 'ok' },
    });
    expect(transport.lastCall.delivery).toBe('response_dropped');
    expect(tracker.getProcessCount(d)).toBe(1);
  });
});

describe('ObservedTransport — fault never leaks', () => {
  it('a fault applies to exactly one call', async () => {
    const d = adapterA.startDialog('T1');
    await expect(
      transport.withFault('drop_request', () => adapterA.sendRequest(d, {})),
    ).rejects.toBeInstanceOf(MessageDroppedError);

    const next = await transport.withFault(undefined, () => adapterA.sendRequest(d, {}));
    expect(next.status).toBe('ok');
  });

  it('an unconsumed fault is cleared when the call throws before reaching the transport', async () => {
    const d = adapterA.startDialog('T1');
    await expect(
      transport.withFault('drop_request', async () => { throw new Error('boom before send'); }),
    ).rejects.toThrow('boom before send');

    // Without withFault: a leaked flag would drop this request.
    expect((await adapterA.sendRequest(d, {})).status).toBe('ok');
  });

  it('a drop_response fault is cleared when the handler throws', async () => {
    const stub = new ObservedTransport(observer());
    let calls = 0;
    stub.registerRequestHandler(async (req: AdapterRequest) => {
      calls += 1;
      if (calls === 1) throw new Error('handler exploded');
      return { dialog_id: req.dialog_id, task_id: req.task_id, seq: req.seq, status: 'ok', result: null };
    });
    const req = { dialog_id: 'D', task_id: 'T', seq: 1, payload: {} };

    await expect(stub.withFault('drop_response', () => stub.sendRequest(req))).rejects.toThrow('handler exploded');
    const second = await stub.sendRequest(req);   // no withFault: a leaked flag would throw here
    expect(second.status).toBe('ok');
  });

  it('withFault clears flags armed outside it before arming its own', async () => {
    const d = adapterA.startDialog('T1');
    transport.dropNextRequestMessage();   // stray flag from elsewhere
    const resp = await transport.withFault(undefined, () => adapterA.sendRequest(d, {}));
    expect(resp.status).toBe('ok');
  });
});

describe('ObservedTransport — delivery semantics unchanged', () => {
  it('without faults behaves like Transport (dedup across calls, same responses)', async () => {
    const d = adapterA.startDialog('T1');
    const first  = await adapterA.sendRequest(d, { v: 1 });
    const replay = await adapterA.retryRequest(d, 1);
    expect(first.status).toBe('ok');
    expect(replay).toMatchObject({ status: 'duplicate', result: first.result });
    expect(tracker.getProcessCount(d)).toBe(1);
  });
});
