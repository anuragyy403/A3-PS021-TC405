/**
 * Five Approved PS-021 Disconnect/Retry Scenarios — Phase 2.5
 *
 * Tests the complete backend system under controlled failure conditions:
 *   1. Multiple Dialogs + Retry → Correct Correlation
 *   2. Request Lost → Retry
 *   3. Response Lost → Duplicate Request
 *   4. Adapter B Restart → Durable State Recovery
 *   5. Mid-Task Disconnect + Adapter A Restart → Resume
 *
 * Every scenario ends in a meaningful lifecycle state, completed by
 * Adapter A (Phase 3b):
 *   1–3  → COMMITTED  (no restart)
 *   4–5  → RECOVERED  (completed after restart + recover())
 *
 * Each scenario exercises REAL backend components:
 *   - Adapter A / Adapter B
 *   - Transport (with failure simulation)
 *   - Dialog Manager
 *   - Request Repository
 *   - SQLite/sql.js durable storage
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../src/db/index.js';
import {
  AdapterA,
  AdapterB,
  Transport,
  MessageDroppedError,
  InMemorySideEffectTracker,
} from '../src/adapters/index.js';

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
  dbPath = tempDbPath('scenarios');
  const handle = openDatabase(dbPath, SQL);
  currentDb = handle.db;

  transport    = new Transport();
  sideEffects  = new InMemorySideEffectTracker();
  adapterA     = new AdapterA(currentDb, dbPath, transport);
  adapterB     = new AdapterB(currentDb, dbPath, transport, sideEffects);
});

afterEach(() => {
  transport.clearFailureFlags();
  transport.unregisterRequestHandler();
  closeDatabase(currentDb);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

// ===========================================================================
// SCENARIO 1: Multiple Dialogs + Retry → Correct Correlation
// ===========================================================================

describe('Scenario 1 — Multiple Dialogs + Retry → Correct Correlation', () => {
  it('correlates retry to correct dialog when multiple dialogs exist', async () => {
    // Step 1: Create Dialog D1 / Task T1
    const d1 = adapterA.startDialog('task-1');
    expect(d1).toBeTruthy();

    // Step 2: Create Dialog D2 / Task T2
    const d2 = adapterA.startDialog('task-2');
    expect(d2).toBeTruthy();
    expect(d2).not.toBe(d1);

    // Step 3: Send request D2/T2/seq=1
    // Step 4: Simulate request loss before Adapter B receives it
    transport.dropNextRequestMessage();

    let requestDropped = false;
    try {
      await adapterA.sendRequest(d2, { op: 'd2-work' });
    } catch (error) {
      expect(error).toBeInstanceOf(MessageDroppedError);
      requestDropped = true;
    }
    expect(requestDropped).toBe(true);

    // Verify B never saw the request
    expect(sideEffects.getProcessCount(d2)).toBe(0);

    // Step 5: Retry the SAME logical request (dialog_id=D2, task_id=T2, seq=1)
    const retryResponse = await adapterA.retryRequest(d2, 1);

    // Step 6-8: Adapter B receives retry, correlates using D2, processes
    expect(retryResponse.status).toBe('ok');
    expect(retryResponse.dialog_id).toBe(d2);
    expect(retryResponse.task_id).toBe('task-2');

    // Expected: D2/T2 is selected (not D1/T1)
    expect(sideEffects.getProcessCount(d2)).toBe(1);
    expect(sideEffects.getProcessCount(d1)).toBe(0);

    // Retry is NOT classified as duplicate (original never reached B)
    expect(retryResponse.status).toBe('ok');

    // Step 9: Adapter A completes D2; D1 was never touched
    expect(adapterA.completeDialog(d2).state).toBe('COMMITTED');

    const dm = adapterB.getDialogManager();
    expect(dm.getDialog(d2)).toMatchObject({ task_id: 'task-2', state: 'COMMITTED', restored: false });
    expect(dm.getDialog(d1)).toMatchObject({ task_id: 'task-1', state: 'INITIATED', restored: false });
  });
});

// ===========================================================================
// SCENARIO 2: Request Lost → Retry
// ===========================================================================

describe('Scenario 2 — Request Lost → Retry', () => {
  it('safely retries a request that was lost before processing', async () => {
    // Step 1: Create D1/T1
    const d1 = adapterA.startDialog('task-scenario2');

    // Step 2: Generate seq=1
    // Step 3: Drop the request before B receives it
    transport.dropNextRequestMessage();

    let dropped = false;
    try {
      await adapterA.sendRequest(d1, { op: 'work' });
    } catch (error) {
      expect(error).toBeInstanceOf(MessageDroppedError);
      dropped = true;
    }
    expect(dropped).toBe(true);

    // Expected: First delivery does not create a processed record
    expect(sideEffects.getProcessCount(d1)).toBe(0);

    // Step 4-7: Retry the same request (same dialog_id, task_id, seq)
    const retryResponse = await adapterA.retryRequest(d1, 1);

    // Step 8: B receives it, correlates it, processes it, persists
    expect(retryResponse.status).toBe('ok');
    expect(retryResponse.dialog_id).toBe(d1);

    // Expected: Retry is treated as new request from B's perspective
    expect(sideEffects.getProcessCount(d1)).toBe(1);

    // Request becomes durably recorded
    const dialog = adapterB.getDialogManager().getDialog(d1);
    expect(dialog!.state).toBe('PROCESSING');

    // Step 9: Task done, no restart → COMMITTED
    expect(adapterA.completeDialog(d1)).toMatchObject({ state: 'COMMITTED', restored: false });
    expect(sideEffects.getProcessCount(d1)).toBe(1);
  });
});

// ===========================================================================
// SCENARIO 3: Response Lost → Duplicate Request
// ===========================================================================

describe('Scenario 3 — Response Lost → Duplicate Request', () => {
  it('prevents duplicate side effect when response is lost', async () => {
    // Step 1: Create D1/T1
    const d1 = adapterA.startDialog('task-scenario3');

    // Step 2-5: Send D1/T1/seq=1, B receives and processes
    // Step 6: Simulate RESPONSE LOSS
    transport.dropNextResponseMessage();

    let responseLost = false;
    try {
      await adapterA.sendRequest(d1, { op: 'critical-work' });
    } catch (error) {
      expect(error).toBeInstanceOf(MessageDroppedError);
      responseLost = true;
    }
    expect(responseLost).toBe(true);

    // B DID execute side effect (response was lost AFTER processing)
    expect(sideEffects.getProcessCount(d1)).toBe(1);

    // Step 7: A does not receive the response
    // Step 8: A retries the SAME logical request (D1, T1, seq=1)
    const retryResponse = await adapterA.retryRequest(d1, 1);

    // Step 9-12: B receives retry, checks durable state, detects duplicate
    expect(retryResponse.status).toBe('duplicate');
    expect(retryResponse.dialog_id).toBe(d1);

    // Step 13: B MUST NOT execute side effect again
    expect(sideEffects.getProcessCount(d1)).toBe(1);  // ← STILL 1

    // Critical assertion: duplicate-side-effect prevention
    // Side effect count: before=0, first=1, retry=still 1

    // Step 14: The duplicate answer acknowledged seq=1, so the task can complete
    expect(adapterA.completeDialog(d1)).toMatchObject({ state: 'COMMITTED', restored: false });
    expect(sideEffects.getProcessCount(d1)).toBe(1);
  });

  it('demonstrates duplicate-side-effect prevention terminology', async () => {
    const d1 = adapterA.startDialog('task-terminology');

    // First processing
    transport.dropNextResponseMessage();
    try {
      await adapterA.sendRequest(d1, {});
    } catch {}

    const countAfterFirst = sideEffects.getProcessCount(d1);
    expect(countAfterFirst).toBe(1);

    // Retry
    const retry = await adapterA.retryRequest(d1, 1);
    expect(retry.status).toBe('duplicate');

    const countAfterRetry = sideEffects.getProcessCount(d1);
    expect(countAfterRetry).toBe(1);

    // Use correct terminology:
    // "duplicate-side-effect prevention after durable processed-state recording"
    // NOT "universal exactly-once delivery"
  });
});

// ---------------------------------------------------------------------------
// Restart helpers
// ---------------------------------------------------------------------------
//
// Both mock adapters run in one process and share one sql.js handle, so a
// "restart" means: drop every in-memory object (adapters, transport, side-
// effect tracker, database handle) and boot fresh ones from the SQLite FILE.
// Nothing survives except what was persisted to disk.

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

// ===========================================================================
// SCENARIO 4: Adapter B Restart → Durable State Recovery
// ===========================================================================

describe('Scenario 4 — Adapter B Restart → Durable State Recovery', () => {
  it('recovers dialog/task identity and deduplication state after restart', async () => {
    const PERSIST_DB = tempDbPath('scenario4-persist');
    try {
      // =================================================================
      // BEFORE RESTART
      // =================================================================
      const before = boot(PERSIST_DB);

      // Step 1: Create D1/T1
      const d1 = before.adapterA.startDialog('task-scenario4');

      // Step 2-3: B processes seq=1, but the response is lost
      before.transport.dropNextResponseMessage();
      await expect(
        before.adapterA.sendRequest(d1, { data: 'before-restart' }),
      ).rejects.toBeInstanceOf(MessageDroppedError);
      expect(before.sideEffects.getProcessCount(d1)).toBe(1);

      // Step 4: Dialog state and processed request are persisted
      expect(before.adapterB.getDialogManager().getDialog(d1)!.state).toBe('PROCESSING');

      // Step 5: Restart — every in-memory object is discarded
      shutdown(before);

      // =================================================================
      // AFTER RESTART
      // =================================================================
      const after = boot(PERSIST_DB);

      // Step 6: Fresh Adapter B sees the same durable dialog
      const dialogAfter = after.adapterB.getDialogManager().getDialog(d1);
      expect(dialogAfter!.dialog_id).toBe(d1);
      expect(dialogAfter!.task_id).toBe('task-scenario4');
      expect(dialogAfter!.state).toBe('PROCESSING');

      // Step 7: Adapter A recovers from durable state — no seq supplied
      const recovered = after.adapterA.recover();
      expect(recovered).toEqual([
        {
          dialog_id:   d1,
          task_id:     'task-scenario4',
          state:       'PROCESSING',
          nextSeq:     2,
          pendingSeqs: [1],
        },
      ]);

      // Step 8: Retry the in-flight seq=1 with its stored payload
      const retryResp = await after.adapterA.retryRequest(d1, 1);

      // Expected: B's durable processed record is recognised → duplicate
      expect(retryResp.status).toBe('duplicate');
      expect(retryResp.result).toMatchObject({ payload: { data: 'before-restart' } });

      // Expected: side effect NOT executed again by the restarted B
      expect(after.sideEffects.getProcessCount(d1)).toBe(0);

      // Expected: seq=1 is now acknowledged
      expect(after.adapterA.recover()[0]!.pendingSeqs).toEqual([]);

      // Step 9: Task completed after a restart → RECOVERED
      expect(after.adapterA.completeDialog(d1)).toMatchObject({
        dialog_id: d1,
        task_id:   'task-scenario4',
        state:     'RECOVERED',
        restored:  true,
      });

      shutdown(after);
    } finally {
      if (fs.existsSync(PERSIST_DB)) fs.unlinkSync(PERSIST_DB);
    }
  });
});

// ===========================================================================
// SCENARIO 5: Mid-Task Disconnect + Adapter A Restart → Resume
// ===========================================================================

describe('Scenario 5 — Mid-Task Disconnect + Adapter A Restart → Resume', () => {
  /**
   * Shared "before restart" half: seq 1 and 2 succeed, seq 3 is in flight
   * when the connection drops and Adapter A goes down.
   */
  async function runUntilDisconnect(
    file: string,
    drop: 'request' | 'response',
  ): Promise<{ d1: string; processedBefore: number }> {
    const before = boot(file);
    const d1 = before.adapterA.startDialog('task-scenario5');

    expect((await before.adapterA.sendRequest(d1, { step: 1 })).status).toBe('ok');
    expect((await before.adapterA.sendRequest(d1, { step: 2 })).status).toBe('ok');

    if (drop === 'request') before.transport.dropNextRequestMessage();
    else                    before.transport.dropNextResponseMessage();

    await expect(
      before.adapterA.sendRequest(d1, { step: 3 }),
    ).rejects.toBeInstanceOf(MessageDroppedError);

    const processedBefore = before.sideEffects.getProcessCount(d1);
    shutdown(before);  // Adapter A crashes mid-task
    return { d1, processedBefore };
  }

  it('response lost mid-task: recovers, retries in-flight seq as duplicate, resumes', async () => {
    const PERSIST_DB = tempDbPath('scenario5-response');
    try {
      const { d1, processedBefore } = await runUntilDisconnect(PERSIST_DB, 'response');
      expect(processedBefore).toBe(3);  // B did process seq=3

      // ---------------- AFTER RESTART ----------------
      const after = boot(PERSIST_DB);

      // Fresh Adapter A knows nothing until it recovers
      expect(after.adapterA.getDialogState(d1)).toBeUndefined();

      const [rec] = after.adapterA.recover();

      // Identity preserved, next seq and in-flight work derived from disk
      expect(rec!.dialog_id).toBe(d1);
      expect(rec!.task_id).toBe('task-scenario5');
      expect(rec!.state).toBe('PROCESSING');
      expect(rec!.pendingSeqs).toEqual([3]);
      expect(rec!.nextSeq).toBe(4);
      expect(after.adapterA.dialogManager.getDialog(d1)!.restored).toBe(true);

      // Retry in-flight seq=3 → B already processed it → duplicate
      const retry3 = await after.adapterA.retryRequest(d1, 3);
      expect(retry3.status).toBe('duplicate');
      expect(retry3.result).toMatchObject({ payload: { step: 3 } });

      // Already-processed seq=1 stays deduplicated too
      expect((await after.adapterA.retryRequest(d1, 1)).status).toBe('duplicate');
      expect(after.sideEffects.getProcessCount(d1)).toBe(0);

      // Continue the SAME task: next request gets seq=4 from durable state
      const resp4 = await after.adapterA.sendRequest(d1, { step: 4 });
      expect(resp4.status).toBe('ok');
      expect(resp4.seq).toBe(4);
      expect(resp4.dialog_id).toBe(d1);
      expect(resp4.task_id).toBe('task-scenario5');
      expect(after.sideEffects.getProcessCount(d1)).toBe(1);

      // No new dialog was created for the task
      const forTask = after.adapterA.dialogManager
        .getAllDialogs()
        .filter(d => d.task_id === 'task-scenario5');
      expect(forTask).toHaveLength(1);

      // Task completed after Adapter A restart → RECOVERED
      expect(after.adapterA.completeDialog(d1)).toMatchObject({
        dialog_id: d1,
        task_id:   'task-scenario5',
        state:     'RECOVERED',
        restored:  true,
      });

      shutdown(after);
    } finally {
      if (fs.existsSync(PERSIST_DB)) fs.unlinkSync(PERSIST_DB);
    }
  });

  it('request lost mid-task: recovers, retries in-flight seq as new, resumes', async () => {
    const PERSIST_DB = tempDbPath('scenario5-request');
    try {
      const { d1, processedBefore } = await runUntilDisconnect(PERSIST_DB, 'request');
      expect(processedBefore).toBe(2);  // seq=3 never reached B

      // ---------------- AFTER RESTART ----------------
      const after = boot(PERSIST_DB);
      const [rec] = after.adapterA.recover();

      expect(rec!.dialog_id).toBe(d1);
      expect(rec!.task_id).toBe('task-scenario5');
      expect(rec!.pendingSeqs).toEqual([3]);
      expect(rec!.nextSeq).toBe(4);

      // Retry in-flight seq=3 → first time B sees it → processed once
      const retry3 = await after.adapterA.retryRequest(d1, 3);
      expect(retry3.status).toBe('ok');
      expect(retry3.result).toMatchObject({ payload: { step: 3 } });
      expect(after.sideEffects.getProcessCount(d1)).toBe(1);

      // Continue with seq=4
      const resp4 = await after.adapterA.sendRequest(d1, { step: 4 });
      expect(resp4.status).toBe('ok');
      expect(resp4.seq).toBe(4);
      expect(after.sideEffects.getProcessCount(d1)).toBe(2);

      // Task completed after Adapter A restart → RECOVERED
      expect(after.adapterA.completeDialog(d1)).toMatchObject({
        state:    'RECOVERED',
        restored: true,
      });

      shutdown(after);
    } finally {
      if (fs.existsSync(PERSIST_DB)) fs.unlinkSync(PERSIST_DB);
    }
  });
});

// ===========================================================================
// Summary Test: All Five Scenarios
// ===========================================================================

describe('Summary — All Five Scenarios', () => {
  it('demonstrates all PS-021 requirements across five scenarios', () => {
    // This test documents what the five scenarios collectively demonstrate:

    // Scenario 1: Correlation via dialog_id (not seq alone)
    // - Multiple dialogs can coexist
    // - Retry is correlated to correct dialog
    // - Lost request vs. duplicate request distinction
    // - D2 ends COMMITTED, untouched D1 stays INITIATED

    // Scenario 2: Request lost before processing
    // - Request never creates processed record
    // - Retry is new from B's perspective
    // - Side effect executes once
    // - Ends COMMITTED

    // Scenario 3: Response lost after processing (R4)
    // - Durable deduplication prevents duplicate side effect
    // - Stored result returned
    // - Observable: side effect count remains 1
    // - Ends COMMITTED

    // Scenario 4: Adapter B restart (R3 for receiving adapter)
    // - Dialog identity preserved across restart
    // - Task identity preserved across restart
    // - Deduplication state survives restart
    // - Durable SQLite recovery
    // - Ends RECOVERED

    // Scenario 5: Adapter A restart (R3 for sending adapter)
    // - Dialog identity preserved
    // - Task identity preserved
    // - Task continues (not restarted)
    // - Same dialog_id/task_id reused
    // - Ends RECOVERED

    // All scenarios use REAL components:
    // ✅ Adapter A / Adapter B
    // ✅ Transport (with failure simulation)
    // ✅ Dialog Manager
    // ✅ Request Repository
    // ✅ SQLite/sql.js durable storage

    expect(true).toBe(true);  // Marker test
  });
});
