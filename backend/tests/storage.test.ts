/**
 * Storage layer conformance tests — Phase 2.3
 *
 * Tests 1–5 verify the SQLite storage layer's core guarantees.
 * Test 5 is the critical one: it proves REAL durability (not in-memory).
 *
 * Driver: sql.js (pure WebAssembly SQLite — no native compilation required)
 * Architecture: identical to better-sqlite3 target; only write-flush differs.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, persistToDisk, closeDatabase } from '../src/db/index.js';
import { DialogRepository }  from '../src/repositories/DialogRepository.js';
import { RequestRepository } from '../src/repositories/RequestRepository.js';
import type { DialogRecord, RequestRecord } from '../src/types/index.js';

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

function now(): string {
  return new Date().toISOString();
}

function makeDialog(overrides: Partial<DialogRecord> = {}): DialogRecord {
  const ts = now();
  return {
    dialog_id:  `dlg-test-${Math.random().toString(36).slice(2, 7)}`,
    task_id:    `task-deadbeef`,
    state:      'INITIATED',
    restored:   false,
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

function makeRequest(dialogId: string, seq: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    dialog_id:    dialogId,
    seq,
    processed_at: now(),
    result:       JSON.stringify({ outcome: 'ok', seq }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-test setup/teardown
// ---------------------------------------------------------------------------

let dbPath:   string;
let dialogs:  DialogRepository;
let requests: RequestRepository;
// The sql.js Database object; managed per-test
let currentDb: ReturnType<typeof openDatabase>['db'];

beforeEach(() => {
  dbPath = tempDbPath('storage');
  const handle = openDatabase(dbPath, SQL);
  currentDb = handle.db;
  dialogs  = new DialogRepository(currentDb);
  requests = new RequestRepository(currentDb);
});

afterEach(() => {
  closeDatabase(currentDb);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

// ---------------------------------------------------------------------------
// Test 1: Create dialog → retrieve it
// ---------------------------------------------------------------------------

describe('Test 1 — create and retrieve dialog', () => {
  it('persists a dialog record and returns it by ID', () => {
    const record = makeDialog({ dialog_id: 'dlg-t1', task_id: 'task-aabbccdd' });
    dialogs.create(record);

    const found = dialogs.findById('dlg-t1');
    expect(found).not.toBeNull();
    expect(found!.dialog_id).toBe('dlg-t1');
    expect(found!.task_id).toBe('task-aabbccdd');
    expect(found!.state).toBe('INITIATED');
    expect(found!.restored).toBe(false);
  });

  it('returns null for a dialog that does not exist', () => {
    expect(dialogs.findById('no-such-dialog')).toBeNull();
  });

  it('findAll returns every inserted dialog', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-a' }));
    dialogs.create(makeDialog({ dialog_id: 'dlg-b' }));

    const all = dialogs.findAll();
    const ids = all.map((d) => d.dialog_id);
    expect(ids).toContain('dlg-a');
    expect(ids).toContain('dlg-b');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Update dialog lifecycle state → change persists
// ---------------------------------------------------------------------------

describe('Test 2 — update lifecycle state', () => {
  it('transitions from INITIATED to PROCESSING and the new state is stored', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-t2' }));

    const updatedAt = now();
    dialogs.updateState('dlg-t2', 'PROCESSING', false, updatedAt);

    const found = dialogs.findById('dlg-t2');
    expect(found!.state).toBe('PROCESSING');
    expect(found!.updated_at).toBe(updatedAt);
  });

  it('transitions from PROCESSING to COMMITTED', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-t2b', state: 'PROCESSING' }));
    dialogs.updateState('dlg-t2b', 'COMMITTED', false, now());
    expect(dialogs.findById('dlg-t2b')!.state).toBe('COMMITTED');
  });

  it('transitions to RECOVERED and sets restored flag', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-t2c', state: 'PROCESSING' }));
    dialogs.updateState('dlg-t2c', 'RECOVERED', true, now());

    const found = dialogs.findById('dlg-t2c');
    expect(found!.state).toBe('RECOVERED');
    expect(found!.restored).toBe(true);
  });

  it('findActive returns only non-terminal dialogs', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-active',    state: 'PROCESSING' }));
    dialogs.create(makeDialog({ dialog_id: 'dlg-initiated', state: 'INITIATED'  }));
    dialogs.create(makeDialog({ dialog_id: 'dlg-committed', state: 'COMMITTED'  }));
    dialogs.create(makeDialog({ dialog_id: 'dlg-recovered', state: 'RECOVERED'  }));
    dialogs.create(makeDialog({ dialog_id: 'dlg-failed',    state: 'FAILED'     }));

    const active = dialogs.findActive();
    const activeIds = active.map((d) => d.dialog_id);

    expect(activeIds).toContain('dlg-active');
    expect(activeIds).toContain('dlg-initiated');
    expect(activeIds).not.toContain('dlg-committed');
    expect(activeIds).not.toContain('dlg-recovered');
    expect(activeIds).not.toContain('dlg-failed');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Record processed request → can be retrieved
// ---------------------------------------------------------------------------

describe('Test 3 — record and retrieve processed request', () => {
  it('records a request and retrieves it by (dialog_id, seq)', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-t3' }));

    const req = makeRequest('dlg-t3', 1, { result: JSON.stringify({ outcome: 'applied' }) });
    const inserted = requests.record(req);

    expect(inserted).toBe(true);

    const found = requests.findByKey('dlg-t3', 1);
    expect(found).not.toBeNull();
    expect(found!.dialog_id).toBe('dlg-t3');
    expect(found!.seq).toBe(1);
    expect(JSON.parse(found!.result)).toEqual({ outcome: 'applied' });
  });

  it('findByDialog returns all requests for that dialog in seq order', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-t3b' }));
    requests.record(makeRequest('dlg-t3b', 1));
    requests.record(makeRequest('dlg-t3b', 2));
    requests.record(makeRequest('dlg-t3b', 3));

    const found = requests.findByDialog('dlg-t3b');
    expect(found.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('returns null for a request that does not exist', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-t3c' }));
    expect(requests.findByKey('dlg-t3c', 99)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Duplicate (dialog_id, seq) → uniqueness prevents second record
// ---------------------------------------------------------------------------

describe('Test 4 — deduplication identity (dialog_id, seq) uniqueness', () => {
  it('first record() returns true; same (dialog_id, seq) returns false', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-t4' }));

    const req = makeRequest('dlg-t4', 1);
    expect(requests.record(req)).toBe(true);

    // Same dialog_id + seq = duplicate
    expect(requests.record({ ...req, processed_at: now(), result: '{"outcome":"dup"}' })).toBe(false);
  });

  it('stored result is from the FIRST insertion, not the duplicate', () => {
    dialogs.create(makeDialog({ dialog_id: 'dlg-t4b' }));
    requests.record(makeRequest('dlg-t4b', 1, { result: JSON.stringify({ outcome: 'original' }) }));
    requests.record(makeRequest('dlg-t4b', 1, { result: JSON.stringify({ outcome: 'should-not-overwrite' }) }));

    const found = requests.findByKey('dlg-t4b', 1);
    expect(JSON.parse(found!.result)).toEqual({ outcome: 'original' });
  });

  it('same seq in a DIFFERENT dialog is NOT a duplicate', () => {
    // Dedup is scoped by dialog_id — different dialogs can share seq values
    dialogs.create(makeDialog({ dialog_id: 'dlg-t4c-D1' }));
    dialogs.create(makeDialog({ dialog_id: 'dlg-t4c-D2' }));

    expect(requests.record(makeRequest('dlg-t4c-D1', 1))).toBe(true);
    expect(requests.record(makeRequest('dlg-t4c-D2', 1))).toBe(true); // NOT a duplicate

    expect(requests.findByKey('dlg-t4c-D1', 1)).not.toBeNull();
    expect(requests.findByKey('dlg-t4c-D2', 1)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 5: Persistence across database close / reopen (REAL durability)
// ---------------------------------------------------------------------------
//
// This is the most important test in this phase.
//
// The frontend simulation uses an in-memory Map that is lost on page reload.
// The backend must provide REAL SQLite persistence that survives process restart.
//
// We simulate process restart by:
//   1. Opening a database → writing records → flushing to disk → closing
//   2. Reopening the database from the same file
//   3. Verifying records are still present
//
// ---------------------------------------------------------------------------

describe('Test 5 — persistence across database close / reopen (REAL durability)', () => {
  it('dialog and request records survive a close/reopen cycle', () => {
    const PERSIST_DB = tempDbPath('persist');
    try {
      // -----------------------------------------------------------------
      // STEP 1: Open, write, flush to disk, close
      // -----------------------------------------------------------------
      const handle1 = openDatabase(PERSIST_DB, SQL);
      const dialogs1  = new DialogRepository(handle1.db);
      const requests1 = new RequestRepository(handle1.db);

      const dialogId = 'dlg-persist-test';
      const ts = now();

      dialogs1.create({
        dialog_id:  dialogId,
        task_id:    'task-cafebabe',
        state:      'PROCESSING',
        restored:   false,
        created_at: ts,
        updated_at: ts,
      });
      requests1.record({
        dialog_id:    dialogId,
        seq:          1,
        processed_at: ts,
        result:       JSON.stringify({ outcome: 'applied', seq: 1 }),
      });

      // Verify in-memory before flush
      expect(dialogs1.findById(dialogId)).not.toBeNull();
      expect(requests1.findByKey(dialogId, 1)).not.toBeNull();

      // Flush to disk ← this is what makes it durable
      persistToDisk(handle1.db, PERSIST_DB);

      // Close — simulates process exit
      closeDatabase(handle1.db);
      expect(fs.existsSync(PERSIST_DB)).toBe(true);

      // -----------------------------------------------------------------
      // STEP 2: Reopen — simulates process restart
      // -----------------------------------------------------------------
      const handle2 = openDatabase(PERSIST_DB, SQL);
      const dialogs2  = new DialogRepository(handle2.db);
      const requests2 = new RequestRepository(handle2.db);

      // -----------------------------------------------------------------
      // STEP 3: Verify data survived
      // -----------------------------------------------------------------
      const foundDialog = dialogs2.findById(dialogId);
      expect(foundDialog).not.toBeNull();
      expect(foundDialog!.dialog_id).toBe(dialogId);
      expect(foundDialog!.task_id).toBe('task-cafebabe');
      expect(foundDialog!.state).toBe('PROCESSING');

      const foundRequest = requests2.findByKey(dialogId, 1);
      expect(foundRequest).not.toBeNull();
      expect(foundRequest!.seq).toBe(1);
      expect(JSON.parse(foundRequest!.result)).toEqual({ outcome: 'applied', seq: 1 });

      // findActive also works after reopen
      const active = dialogs2.findActive();
      expect(active.map((d) => d.dialog_id)).toContain(dialogId);

      closeDatabase(handle2.db);
    } finally {
      if (fs.existsSync(PERSIST_DB)) fs.unlinkSync(PERSIST_DB);
    }
  });

  it('deduplication key survives close/reopen — prevents double-apply after restart', () => {
    // This is the core crash-recovery guarantee:
    // If seq=1 was processed and persisted before a crash, a retry of seq=1
    // after restart must be detected as a duplicate.

    const PERSIST_DB2 = tempDbPath('persist2');
    try {
      const handle1 = openDatabase(PERSIST_DB2, SQL);
      const dialogs1  = new DialogRepository(handle1.db);
      const requests1 = new RequestRepository(handle1.db);

      const dialogId = 'dlg-dedup-persist';
      const ts = now();
      dialogs1.create({
        dialog_id:  dialogId,
        task_id:    'task-00000001',
        state:      'PROCESSING',
        restored:   false,
        created_at: ts,
        updated_at: ts,
      });

      // First processing of seq=1 — persisted before simulated crash
      expect(requests1.record(makeRequest(dialogId, 1))).toBe(true);

      // Flush to disk (simulates durable commit before crash)
      persistToDisk(handle1.db, PERSIST_DB2);

      // Close — simulates crash
      closeDatabase(handle1.db);

      // Reopen — simulates restart
      const handle2 = openDatabase(PERSIST_DB2, SQL);
      const requests2 = new RequestRepository(handle2.db);

      // Retry of seq=1 after restart — MUST be recognised as duplicate
      const afterRestart = requests2.record(makeRequest(dialogId, 1));
      expect(afterRestart).toBe(false); // ← duplicate detected after restart

      // Original record is still there
      expect(requests2.findByKey(dialogId, 1)).not.toBeNull();

      closeDatabase(handle2.db);
    } finally {
      if (fs.existsSync(PERSIST_DB2)) fs.unlinkSync(PERSIST_DB2);
    }
  });
});

// ---------------------------------------------------------------------------
// Aggregate queries
// ---------------------------------------------------------------------------

describe('Aggregate queries', () => {
  it('countByState returns correct counts per state', () => {
    dialogs.create(makeDialog({ dialog_id: 'agg-1', state: 'COMMITTED'  }));
    dialogs.create(makeDialog({ dialog_id: 'agg-2', state: 'COMMITTED'  }));
    dialogs.create(makeDialog({ dialog_id: 'agg-3', state: 'RECOVERED'  }));
    dialogs.create(makeDialog({ dialog_id: 'agg-4', state: 'PROCESSING' }));

    const counts = dialogs.countByState();
    expect(counts['COMMITTED']).toBe(2);
    expect(counts['RECOVERED']).toBe(1);
    expect(counts['PROCESSING']).toBe(1);
  });

  it('totalCount returns total processed requests', () => {
    dialogs.create(makeDialog({ dialog_id: 'cnt-d1' }));
    requests.record(makeRequest('cnt-d1', 1));
    requests.record(makeRequest('cnt-d1', 2));
    requests.record(makeRequest('cnt-d1', 3));

    expect(requests.totalCount()).toBe(3);
  });
});
