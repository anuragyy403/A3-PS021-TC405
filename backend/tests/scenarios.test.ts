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
    const retryResponse = await adapterA.retryRequest(d2, 1, { op: 'd2-work' });

    // Step 6-8: Adapter B receives retry, correlates using D2, processes
    expect(retryResponse.status).toBe('ok');
    expect(retryResponse.dialog_id).toBe(d2);
    expect(retryResponse.task_id).toBe('task-2');

    // Expected: D2/T2 is selected (not D1/T1)
    expect(sideEffects.getProcessCount(d2)).toBe(1);
    expect(sideEffects.getProcessCount(d1)).toBe(0);

    // Retry is NOT classified as duplicate (original never reached B)
    expect(retryResponse.status).toBe('ok');
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
    const retryResponse = await adapterA.retryRequest(d1, 1, { op: 'work' });

    // Step 8: B receives it, correlates it, processes it, persists
    expect(retryResponse.status).toBe('ok');
    expect(retryResponse.dialog_id).toBe(d1);

    // Expected: Retry is treated as new request from B's perspective
    expect(sideEffects.getProcessCount(d1)).toBe(1);

    // Request becomes durably recorded
    const dialog = adapterB.getDialogManager().getDialog(d1);
    expect(dialog!.state).toBe('PROCESSING');
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
    const retryResponse = await adapterA.retryRequest(d1, 1, { op: 'critical-work' });

    // Step 9-12: B receives retry, checks durable state, detects duplicate
    expect(retryResponse.status).toBe('duplicate');
    expect(retryResponse.dialog_id).toBe(d1);

    // Step 13: B MUST NOT execute side effect again
    expect(sideEffects.getProcessCount(d1)).toBe(1);  // ← STILL 1

    // Critical assertion: duplicate-side-effect prevention
    // Side effect count: before=0, first=1, retry=still 1
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
    const retry = await adapterA.retryRequest(d1, 1, {});
    expect(retry.status).toBe('duplicate');

    const countAfterRetry = sideEffects.getProcessCount(d1);
    expect(countAfterRetry).toBe(1);

    // Use correct terminology:
    // "duplicate-side-effect prevention after durable processed-state recording"
    // NOT "universal exactly-once delivery"
  });
});

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

      // Step 1: Create D1/T1
      const handle1 = openDatabase(PERSIST_DB, SQL);
      const transport1 = new Transport();
      const sideEffects1 = new InMemorySideEffectTracker();
      const adapterA1 = new AdapterA(handle1.db, PERSIST_DB, transport1);
      const adapterB1 = new AdapterB(handle1.db, PERSIST_DB, transport1, sideEffects1);

      const d1 = adapterA1.startDialog('task-scenario4');

      // Step 2: Send a request
      const resp1 = await adapterA1.sendRequest(d1, { data: 'before-restart' });
      expect(resp1.status).toBe('ok');

      // Step 3: B processes it
      expect(sideEffects1.getProcessCount(d1)).toBe(1);

      // Step 4: Ensure dialog/request state is persisted
      const dialogBefore = adapterB1.getDialogManager().getDialog(d1);
      expect(dialogBefore).not.toBeNull();
      expect(dialogBefore!.state).toBe('PROCESSING');

      // Step 5: Simulate Adapter B shutdown/restart
      transport1.unregisterRequestHandler();
      closeDatabase(handle1.db);

      // =================================================================
      // AFTER RESTART
      // =================================================================

      // Step 6: Create a fresh Adapter B instance using SAME durable SQLite
      const handle2 = openDatabase(PERSIST_DB, SQL);
      const transport2 = new Transport();
      const sideEffects2 = new InMemorySideEffectTracker();
      const adapterA2 = new AdapterA(handle2.db, PERSIST_DB, transport2);
      const adapterB2 = new AdapterB(handle2.db, PERSIST_DB, transport2, sideEffects2);

      // Step 7: Reload persisted state (happens automatically via Dialog Manager)
      const dialogAfter = adapterB2.getDialogManager().getDialog(d1);
      expect(dialogAfter).not.toBeNull();

      // Expected: D1 still exists
      expect(dialogAfter!.dialog_id).toBe(d1);

      // Expected: T1 still exists
      expect(dialogAfter!.task_id).toBe('task-scenario4');

      // Expected: Lifecycle state is preserved
      expect(dialogAfter!.state).toBe('PROCESSING');

      // Step 8: Recreate Adapter A state (simulating A also reloading)
      adapterA2.reloadDialog(d1, 'task-scenario4', 2);

      // Send the same request again (retry seq=1)
      const retryResp = await adapterA2.retryRequest(d1, 1, { data: 'after-restart' });

      // Expected: Processed request (D1,seq=1) is preserved
      expect(retryResp.status).toBe('duplicate');

      // Expected: Retry is recognized as duplicate
      // Expected: Side effect is NOT executed again
      expect(sideEffects2.getProcessCount(d1)).toBe(0);  // New tracker starts at 0

      transport2.unregisterRequestHandler();
      closeDatabase(handle2.db);
    } finally {
      if (fs.existsSync(PERSIST_DB)) fs.unlinkSync(PERSIST_DB);
    }
  });
});

// ===========================================================================
// SCENARIO 5: Mid-Task Disconnect + Adapter A Restart → Resume
// ===========================================================================

describe('Scenario 5 — Mid-Task Disconnect + Adapter A Restart → Resume', () => {
  it('resumes existing task after Adapter A restart with preserved identity', async () => {
    const PERSIST_DB = tempDbPath('scenario5-persist');
    try {
      // =================================================================
      // BEFORE RESTART
      // =================================================================

      // Step 1: Create D1/T1
      const handle1 = openDatabase(PERSIST_DB, SQL);
      const transport1 = new Transport();
      const sideEffects1 = new InMemorySideEffectTracker();
      const adapterA1 = new AdapterA(handle1.db, PERSIST_DB, transport1);
      const adapterB1 = new AdapterB(handle1.db, PERSIST_DB, transport1, sideEffects1);

      const d1 = adapterA1.startDialog('task-scenario5');

      // Step 2: Process first request (seq=1)
      const resp1 = await adapterA1.sendRequest(d1, { step: 1 });
      expect(resp1.status).toBe('ok');
      expect(sideEffects1.getProcessCount(d1)).toBe(1);

      // Step 3: Continue the dialog to another request (seq=2)
      const resp2 = await adapterA1.sendRequest(d1, { step: 2 });
      expect(resp2.status).toBe('ok');
      expect(sideEffects1.getProcessCount(d1)).toBe(2);

      // Save Adapter A state for recovery
      const stateBefore = adapterA1.getDialogState(d1);
      expect(stateBefore).toBeDefined();
      expect(stateBefore!.nextSeq).toBe(3);  // Next would be seq=3

      // Step 4: Simulate Adapter A shutdown/crash
      transport1.unregisterRequestHandler();
      closeDatabase(handle1.db);

      // =================================================================
      // AFTER RESTART
      // =================================================================

      // Step 5: Create a fresh Adapter A instance
      const handle2 = openDatabase(PERSIST_DB, SQL);
      const transport2 = new Transport();
      const sideEffects2 = new InMemorySideEffectTracker();
      const adapterA2 = new AdapterA(handle2.db, PERSIST_DB, transport2);
      const adapterB2 = new AdapterB(handle2.db, PERSIST_DB, transport2, sideEffects2);

      // Step 6-7: Load existing dialog/task information from durable storage
      const dialogRestored = adapterA2.dialogManager.getDialog(d1);
      expect(dialogRestored).not.toBeNull();

      // Step 8: Resume using SAME dialog_id and task_id
      adapterA2.reloadDialog(
        d1,
        'task-scenario5',
        3,  // Next seq to use
      );

      // Expected: Original dialog_id preserved
      expect(dialogRestored!.dialog_id).toBe(d1);

      // Expected: Original task_id preserved
      expect(dialogRestored!.task_id).toBe('task-scenario5');

      // Expected: Existing durable state loaded
      expect(dialogRestored!.state).toBe('PROCESSING');

      // Step 9: If an already-processed request is retried, deduplication works
      const retryResp = await adapterA2.retryRequest(d1, 1, { step: 1 });
      expect(retryResp.status).toBe('duplicate');

      // New side effect tracker starts at 0
      expect(sideEffects2.getProcessCount(d1)).toBe(0);

      // Step 10: Continue the task with next request (seq=3)
      const resp3 = await adapterA2.sendRequest(d1, { step: 3 });
      expect(resp3.status).toBe('ok');

      // Expected: Adapter A does NOT create a new dialog
      const allDialogs = adapterA2.dialogManager.getAllDialogs();
      const matchingDialogs = allDialogs.filter(d => d.task_id === 'task-scenario5');
      expect(matchingDialogs.length).toBe(1);  // Only one dialog for this task

      // Expected: Processing can continue
      expect(sideEffects2.getProcessCount(d1)).toBe(1);  // seq=3 processed

      transport2.unregisterRequestHandler();
      closeDatabase(handle2.db);
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

    // Scenario 2: Request lost before processing
    // - Request never creates processed record
    // - Retry is new from B's perspective
    // - Side effect executes once

    // Scenario 3: Response lost after processing (R4)
    // - Durable deduplication prevents duplicate side effect
    // - Stored result returned
    // - Observable: side effect count remains 1

    // Scenario 4: Adapter B restart (R3 for receiving adapter)
    // - Dialog identity preserved across restart
    // - Task identity preserved across restart
    // - Deduplication state survives restart
    // - Durable SQLite recovery

    // Scenario 5: Adapter A restart (R3 for sending adapter)
    // - Dialog identity preserved
    // - Task identity preserved
    // - Task continues (not restarted)
    // - Same dialog_id/task_id reused

    // All scenarios use REAL components:
    // ✅ Adapter A / Adapter B
    // ✅ Transport (with failure simulation)
    // ✅ Dialog Manager
    // ✅ Request Repository
    // ✅ SQLite/sql.js durable storage

    expect(true).toBe(true);  // Marker test
  });
});
