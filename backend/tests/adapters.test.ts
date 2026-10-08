/**
 * Adapter A + Adapter B integration tests — Phase 2.3
 *
 * Tests the mock agent adapters: communication, correlation, deduplication,
 * lifecycle transitions, and duplicate-side-effect prevention.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../src/db/index.js';
import { AdapterA, AdapterB, Transport, InMemorySideEffectTracker } from '../src/adapters/index.js';

// ---------------------------------------------------------------------------
// Engine — initialise once for the whole test file
// ---------------------------------------------------------------------------

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(label: string): string {
  return path.join(os.tmpdir(), `nighthawks-test-${label}-${Date.now()}.db`);
}

// ---------------------------------------------------------------------------
// Per-test setup/teardown
// ---------------------------------------------------------------------------

let dbPath:       string;
let currentDb:    ReturnType<typeof openDatabase>['db'];
let transport:    Transport;
let adapterA:     AdapterA;
let adapterB:     AdapterB;
let sideEffects:  InMemorySideEffectTracker;

beforeEach(() => {
  dbPath = tempDbPath('adapters');
  const handle = openDatabase(dbPath, SQL);
  currentDb = handle.db;

  transport    = new Transport();
  sideEffects  = new InMemorySideEffectTracker();
  adapterA     = new AdapterA(currentDb, dbPath, transport);
  adapterB     = new AdapterB(currentDb, dbPath, transport, sideEffects);
});

afterEach(() => {
  transport.unregisterRequestHandler();
  closeDatabase(currentDb);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

// ---------------------------------------------------------------------------
// Test 1: Adapter A can start a dialog
// ---------------------------------------------------------------------------

describe('Test 1 — Adapter A starts dialog', () => {
  it('startDialog creates a dialog and returns dialog_id', () => {
    const dialogId = adapterA.startDialog('task-123');

    expect(dialogId).toBeTruthy();
    expect(typeof dialogId).toBe('string');
    expect(dialogId).toMatch(/^dlg-/);
  });

  it('startDialog creates dialog in INITIATED state', () => {
    const dialogId = adapterA.startDialog('task-456');

    const dialog = adapterB.getDialogManager().getDialog(dialogId);
    expect(dialog).not.toBeNull();
    expect(dialog!.state).toBe('INITIATED');
  });

  it('startDialog initializes sequence tracking', () => {
    const dialogId = adapterA.startDialog('task-789');

    const dialogState = adapterA.getDialogState(dialogId);
    expect(dialogState).toBeDefined();
    expect(dialogState!.nextSeq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Adapter A creates valid dialog_id/task_id pair
// ---------------------------------------------------------------------------

describe('Test 2 — Valid dialog_id/task_id', () => {
  it('creates unique dialog_id for each dialog', () => {
    const dialogId1 = adapterA.startDialog('task-1');
    const dialogId2 = adapterA.startDialog('task-2');

    expect(dialogId1).not.toBe(dialogId2);
  });

  it('preserves task_id', () => {
    const taskId = 'task-alpha-beta';
    const dialogId = adapterA.startDialog(taskId);

    const dialog = adapterB.getDialogManager().getDialog(dialogId);
    expect(dialog!.task_id).toBe(taskId);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Adapter A sends request with dialog_id/task_id/seq
// ---------------------------------------------------------------------------

describe('Test 3 — Request structure', () => {
  it('sendRequest generates request with all required fields', async () => {
    const dialogId = adapterA.startDialog('task-req-1');
    const payload = { operation: 'test' };

    const response = await adapterA.sendRequest(dialogId, payload);

    expect(response.dialog_id).toBe(dialogId);
    expect(response.task_id).toBe('task-req-1');
    expect(response.seq).toBe(1);
  });

  it('sendRequest increments seq for each request', async () => {
    const dialogId = adapterA.startDialog('task-req-2');

    const resp1 = await adapterA.sendRequest(dialogId, { op: 'first' });
    const resp2 = await adapterA.sendRequest(dialogId, { op: 'second' });
    const resp3 = await adapterA.sendRequest(dialogId, { op: 'third' });

    expect(resp1.seq).toBe(1);
    expect(resp2.seq).toBe(2);
    expect(resp3.seq).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Adapter B receives and correlates correctly
// ---------------------------------------------------------------------------

describe('Test 4 — Correlation', () => {
  it('correlates request to existing dialog', async () => {
    const dialogId = adapterA.startDialog('task-cor-1');

    const response = await adapterA.sendRequest(dialogId, { test: true });

    expect(response.status).toBe('ok');
    expect(response.dialog_id).toBe(dialogId);
  });

  it('rejects request for non-existent dialog', async () => {
    // Manually build request with fake dialog_id (bypass AdapterA)
    const fakeRequest = {
      dialog_id: 'dlg-nonexistent',
      task_id:   'task-123',
      seq:       1,
      payload:   {},
    };

    const response = await transport.sendRequest(fakeRequest);

    expect(response.status).toBe('error');
    expect(response.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Adapter B verifies task identity
// ---------------------------------------------------------------------------

describe('Test 5 — Task identity verification', () => {
  it('accepts request with matching task_id', async () => {
    const dialogId = adapterA.startDialog('task-match');

    const response = await adapterA.sendRequest(dialogId, {});

    expect(response.status).toBe('ok');
  });

  it('rejects request with mismatched task_id', async () => {
    const dialogId = adapterA.startDialog('task-original');

    // Manually build request with wrong task_id
    const wrongRequest = {
      dialog_id: dialogId,
      task_id:   'task-different',
      seq:       1,
      payload:   {},
    };

    const response = await transport.sendRequest(wrongRequest);

    expect(response.status).toBe('error');
    expect(response.error).toContain('mismatch');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Request processed exactly once under normal delivery
// ---------------------------------------------------------------------------

describe('Test 6 — Normal processing', () => {
  it('processes request and executes side effect once', async () => {
    const dialogId = adapterA.startDialog('task-proc-1');

    await adapterA.sendRequest(dialogId, { op: 'work' });

    const processCount = sideEffects.getProcessCount(dialogId);
    expect(processCount).toBe(1);
  });

  it('processes multiple requests and executes side effect for each', async () => {
    const dialogId = adapterA.startDialog('task-proc-2');

    await adapterA.sendRequest(dialogId, { op: 'first' });
    await adapterA.sendRequest(dialogId, { op: 'second' });
    await adapterA.sendRequest(dialogId, { op: 'third' });

    const processCount = sideEffects.getProcessCount(dialogId);
    expect(processCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Duplicate request with same (dialog_id, seq) detected
// ---------------------------------------------------------------------------

describe('Test 7 — Duplicate detection', () => {
  it('detects duplicate when same (dialog_id, seq) sent twice', async () => {
    const dialogId = adapterA.startDialog('task-dup-1');

    // First request
    const resp1 = await adapterA.sendRequest(dialogId, { op: 'work' });
    expect(resp1.status).toBe('ok');

    // Retry with same seq
    const resp2 = await adapterA.retryRequest(dialogId, 1);
    expect(resp2.status).toBe('duplicate');
  });

  it('returns stored result for duplicate', async () => {
    const dialogId = adapterA.startDialog('task-dup-2');
    const payload = { data: 'original' };

    // First request
    const resp1 = await adapterA.sendRequest(dialogId, payload);
    const originalResult = resp1.result;

    // Retry with same seq
    const resp2 = await adapterA.retryRequest(dialogId, 1);

    expect(resp2.status).toBe('duplicate');
    expect(resp2.result).toEqual(originalResult);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Duplicate processing does NOT repeat side effect
// ---------------------------------------------------------------------------

describe('Test 8 — Duplicate-side-effect prevention', () => {
  it('side effect executed once, not repeated on duplicate', async () => {
    const dialogId = adapterA.startDialog('task-side-1');

    // First request → side effect executes
    await adapterA.sendRequest(dialogId, { op: 'work' });
    expect(sideEffects.getProcessCount(dialogId)).toBe(1);

    // Duplicate → side effect NOT executed
    await adapterA.retryRequest(dialogId, 1);
    expect(sideEffects.getProcessCount(dialogId)).toBe(1);  // ← still 1

    // Another duplicate → still not executed
    await adapterA.retryRequest(dialogId, 1);
    expect(sideEffects.getProcessCount(dialogId)).toBe(1);  // ← still 1
  });

  it('different seq values each execute side effect', async () => {
    const dialogId = adapterA.startDialog('task-side-2');

    await adapterA.sendRequest(dialogId, { op: '1' });  // seq=1
    expect(sideEffects.getProcessCount(dialogId)).toBe(1);

    await adapterA.sendRequest(dialogId, { op: '2' });  // seq=2
    expect(sideEffects.getProcessCount(dialogId)).toBe(2);

    await adapterA.sendRequest(dialogId, { op: '3' });  // seq=3
    expect(sideEffects.getProcessCount(dialogId)).toBe(3);

    // Retry seq=1 → no new side effect
    await adapterA.retryRequest(dialogId, 1);
    expect(sideEffects.getProcessCount(dialogId)).toBe(3);  // ← still 3
  });
});

// ---------------------------------------------------------------------------
// Test 9: Retry preserves dialog_id
// ---------------------------------------------------------------------------

describe('Test 9 — Retry preserves dialog_id', () => {
  it('retry uses same dialog_id', async () => {
    const dialogId = adapterA.startDialog('task-retry-1');

    const resp1 = await adapterA.sendRequest(dialogId, {});
    const resp2 = await adapterA.retryRequest(dialogId, 1);

    expect(resp1.dialog_id).toBe(dialogId);
    expect(resp2.dialog_id).toBe(dialogId);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Retry preserves task_id
// ---------------------------------------------------------------------------

describe('Test 10 — Retry preserves task_id', () => {
  it('retry uses same task_id', async () => {
    const taskId = 'task-retry-preserve';
    const dialogId = adapterA.startDialog(taskId);

    const resp1 = await adapterA.sendRequest(dialogId, {});
    const resp2 = await adapterA.retryRequest(dialogId, 1);

    expect(resp1.task_id).toBe(taskId);
    expect(resp2.task_id).toBe(taskId);
  });
});

// ---------------------------------------------------------------------------
// Test 11: Retry preserves seq
// ---------------------------------------------------------------------------

describe('Test 11 — Retry preserves seq', () => {
  it('retry uses same seq', async () => {
    const dialogId = adapterA.startDialog('task-retry-seq');

    const resp1 = await adapterA.sendRequest(dialogId, {});  // seq=1
    const resp2 = await adapterA.retryRequest(dialogId, 1);  // seq=1 again

    expect(resp1.seq).toBe(1);
    expect(resp2.seq).toBe(1);
  });

  it('multiple retries all use same seq', async () => {
    const dialogId = adapterA.startDialog('task-retry-multi');

    const resp1 = await adapterA.sendRequest(dialogId, {});
    const resp2 = await adapterA.retryRequest(dialogId, 1);
    const resp3 = await adapterA.retryRequest(dialogId, 1);
    const resp4 = await adapterA.retryRequest(dialogId, 1);

    expect(resp1.seq).toBe(1);
    expect(resp2.seq).toBe(1);
    expect(resp3.seq).toBe(1);
    expect(resp4.seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Two dialogs with same seq do not collide
// ---------------------------------------------------------------------------

describe('Test 12 — Deduplication scoping', () => {
  it('same seq in different dialogs do not collide', async () => {
    const dialogId1 = adapterA.startDialog('task-1');
    const dialogId2 = adapterA.startDialog('task-2');

    // Both send seq=1
    const resp1 = await adapterA.sendRequest(dialogId1, { dialog: 1 });
    const resp2 = await adapterA.sendRequest(dialogId2, { dialog: 2 });

    // Both are OK (not duplicates of each other)
    expect(resp1.status).toBe('ok');
    expect(resp2.status).toBe('ok');

    // Each dialog executed side effect once
    expect(sideEffects.getProcessCount(dialogId1)).toBe(1);
    expect(sideEffects.getProcessCount(dialogId2)).toBe(1);
  });

  it('retry in one dialog does not affect other dialog', async () => {
    const dialogId1 = adapterA.startDialog('task-a');
    const dialogId2 = adapterA.startDialog('task-b');

    // D1: seq=1
    await adapterA.sendRequest(dialogId1, {});
    expect(sideEffects.getProcessCount(dialogId1)).toBe(1);

    // D2: seq=1
    await adapterA.sendRequest(dialogId2, {});
    expect(sideEffects.getProcessCount(dialogId2)).toBe(1);

    // D1: retry seq=1 → duplicate
    const retryResp = await adapterA.retryRequest(dialogId1, 1);
    expect(retryResp.status).toBe('duplicate');
    expect(sideEffects.getProcessCount(dialogId1)).toBe(1);  // unchanged

    // D2: seq=2 → new request
    await adapterA.sendRequest(dialogId2, {});
    expect(sideEffects.getProcessCount(dialogId2)).toBe(2);  // incremented
  });
});

// ---------------------------------------------------------------------------
// Test 13: Successful processing results in expected lifecycle transitions
// ---------------------------------------------------------------------------

describe('Test 13 — Lifecycle transitions', () => {
  it('first request transitions INITIATED → PROCESSING', async () => {
    const dialogId = adapterA.startDialog('task-lifecycle-1');

    const dialog1 = adapterB.getDialogManager().getDialog(dialogId);
    expect(dialog1!.state).toBe('INITIATED');

    await adapterA.sendRequest(dialogId, {});

    const dialog2 = adapterB.getDialogManager().getDialog(dialogId);
    expect(dialog2!.state).toBe('PROCESSING');
  });

  it('duplicate request does not cause additional transitions', async () => {
    const dialogId = adapterA.startDialog('task-lifecycle-2');

    await adapterA.sendRequest(dialogId, {});  // INITIATED → PROCESSING

    const dialog1 = adapterB.getDialogManager().getDialog(dialogId);
    expect(dialog1!.state).toBe('PROCESSING');

    await adapterA.retryRequest(dialogId, 1);  // duplicate

    const dialog2 = adapterB.getDialogManager().getDialog(dialogId);
    expect(dialog2!.state).toBe('PROCESSING');  // unchanged
  });

  it('can transition to COMMITTED after processing', async () => {
    const dialogId = adapterA.startDialog('task-lifecycle-3');

    await adapterA.sendRequest(dialogId, {});

    const dialog1 = adapterB.getDialogManager().getDialog(dialogId);
    expect(dialog1!.state).toBe('PROCESSING');

    adapterA.completeDialog(dialogId);  // Adapter A owns completion

    const dialog2 = adapterB.getDialogManager().getDialog(dialogId);
    expect(dialog2!.state).toBe('COMMITTED');
  });
});

// ---------------------------------------------------------------------------
// Test 14: Missing dialog is rejected
// ---------------------------------------------------------------------------

describe('Test 14 — Missing dialog rejection', () => {
  it('request for non-existent dialog returns error', async () => {
    const fakeRequest = {
      dialog_id: 'dlg-does-not-exist',
      task_id:   'task-123',
      seq:       1,
      payload:   {},
    };

    const response = await transport.sendRequest(fakeRequest);

    expect(response.status).toBe('error');
    expect(response.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Test 15: Task identity mismatch is rejected
// ---------------------------------------------------------------------------

describe('Test 15 — Task identity mismatch rejection', () => {
  it('request with wrong task_id returns error', async () => {
    const dialogId = adapterA.startDialog('task-correct');

    const wrongRequest = {
      dialog_id: dialogId,
      task_id:   'task-wrong',
      seq:       1,
      payload:   {},
    };

    const response = await transport.sendRequest(wrongRequest);

    expect(response.status).toBe('error');
    expect(response.error).toContain('mismatch');
  });
});

// ---------------------------------------------------------------------------
// Test 16: Durable deduplication survives database reload
// ---------------------------------------------------------------------------

describe('Test 16 — Durable deduplication persistence', () => {
  it('deduplication record survives close/reopen', async () => {
    const PERSIST_DB = tempDbPath('dedup-persist');
    try {
      // Step 1: Create dialog, send request, close
      const handle1 = openDatabase(PERSIST_DB, SQL);
      const transport1 = new Transport();
      const sideEffects1 = new InMemorySideEffectTracker();
      const adapterA1 = new AdapterA(handle1.db, PERSIST_DB, transport1);
      const adapterB1 = new AdapterB(handle1.db, PERSIST_DB, transport1, sideEffects1);

      const dialogId = adapterA1.startDialog('task-persist');
      const resp1 = await adapterA1.sendRequest(dialogId, { data: 'original' });

      expect(resp1.status).toBe('ok');
      expect(sideEffects1.getProcessCount(dialogId)).toBe(1);

      transport1.unregisterRequestHandler();
      closeDatabase(handle1.db);

      // Step 2: Reopen, retry same request
      const handle2 = openDatabase(PERSIST_DB, SQL);
      const transport2 = new Transport();
      const sideEffects2 = new InMemorySideEffectTracker();
      const adapterA2 = new AdapterA(handle2.db, PERSIST_DB, transport2);
      const adapterB2 = new AdapterB(handle2.db, PERSIST_DB, transport2, sideEffects2);

      // Adapter A rebuilds its state from durable storage
      const [recovered] = adapterA2.recover();
      expect(recovered!.dialog_id).toBe(dialogId);
      expect(recovered!.nextSeq).toBe(2);

      // Retry seq=1
      const resp2 = await adapterA2.retryRequest(dialogId, 1);

      // Duplicate detected after restart
      expect(resp2.status).toBe('duplicate');

      // Side effect NOT re-executed (new tracker starts at 0)
      expect(sideEffects2.getProcessCount(dialogId)).toBe(0);

      transport2.unregisterRequestHandler();
      closeDatabase(handle2.db);
    } finally {
      if (fs.existsSync(PERSIST_DB)) fs.unlinkSync(PERSIST_DB);
    }
  });
});
