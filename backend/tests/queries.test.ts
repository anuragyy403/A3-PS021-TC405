/**
 * Phase 6a — read-only queries added for the API (docs/API_DESIGN.md §7).
 *
 *   OutboundRequestRepository.findByDialog / sumAttempts
 *   DialogRepository.countRestored
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../src/db/index.js';
import { DialogRepository } from '../src/repositories/DialogRepository.js';
import { OutboundRequestRepository } from '../src/repositories/OutboundRequestRepository.js';

let SQL: SqlJsStatic;
let handle: ReturnType<typeof openDatabase>;
let dialogs: DialogRepository;
let outbound: OutboundRequestRepository;

beforeAll(async () => {
  SQL = await initDb();
});

beforeEach(() => {
  handle   = openDatabase(':memory:', SQL);
  dialogs  = new DialogRepository(handle.db, ':memory:');
  outbound = new OutboundRequestRepository(handle.db, ':memory:');
  for (const id of ['D1', 'D2', 'D3']) {
    dialogs.create({ dialog_id: id, task_id: `T-${id}`, state: 'INITIATED', restored: false });
  }
});

afterEach(() => closeDatabase(handle.db));

describe('OutboundRequestRepository.findByDialog', () => {
  it('returns [] for a dialog with no requests', () => {
    expect(outbound.findByDialog('D1')).toEqual([]);
  });

  it('returns PENDING and ACKED rows of one dialog, in seq order', () => {
    outbound.recordPending('D1', 2, '{"b":2}');
    outbound.recordPending('D1', 1, '{"a":1}');
    outbound.recordPending('D2', 1, '{}');
    outbound.markAcked('D1', 1);

    expect(outbound.findByDialog('D1')).toEqual([
      { dialog_id: 'D1', seq: 1, payload: '{"a":1}', status: 'ACKED',   attempts: 1 },
      { dialog_id: 'D1', seq: 2, payload: '{"b":2}', status: 'PENDING', attempts: 1 },
    ]);
  });
});

describe('OutboundRequestRepository.sumAttempts', () => {
  it('is 0 with no rows, per dialog and in total', () => {
    expect(outbound.sumAttempts()).toBe(0);
    expect(outbound.sumAttempts('D1')).toBe(0);
  });

  it('sums attempts per dialog and across all dialogs', () => {
    outbound.recordPending('D1', 1, '{}');   // 1
    outbound.incrementAttempts('D1', 1);     // 2
    outbound.incrementAttempts('D1', 1);     // 3
    outbound.recordPending('D1', 2, '{}');   // 1
    outbound.recordPending('D2', 1, '{}');   // 1

    expect(outbound.sumAttempts('D1')).toBe(4);
    expect(outbound.sumAttempts('D2')).toBe(1);
    expect(outbound.sumAttempts('D3')).toBe(0);
    expect(outbound.sumAttempts()).toBe(5);
  });
});

describe('DialogRepository.countRestored', () => {
  it('counts only dialogs with restored = 1, in any state', () => {
    expect(dialogs.countRestored()).toBe(0);

    dialogs.updateState('D1', 'PROCESSING', true);
    dialogs.updateState('D2', 'RECOVERED', true);
    dialogs.updateState('D3', 'COMMITTED', false);

    expect(dialogs.countRestored()).toBe(2);
  });
});
