/**
 * Dialog Manager unit tests — Phase 2.2
 *
 * Tests business logic layer: dialog creation, correlation, lifecycle
 * validation, and recovery operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../src/db/index.js';
import { DialogManager } from '../src/services/DialogManager.js';
import {
  NotFoundError,
  InvalidTransitionError,
  ConflictError,
} from '../src/errors.js';

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

let dbPath:  string;
let manager: DialogManager;
let currentDb: ReturnType<typeof openDatabase>['db'];

beforeEach(() => {
  dbPath = tempDbPath('dialog-manager');
  const handle = openDatabase(dbPath, SQL);
  currentDb = handle.db;
  manager = new DialogManager(currentDb, dbPath);
});

afterEach(() => {
  closeDatabase(currentDb);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

// ---------------------------------------------------------------------------
// Test 1: Create a dialog successfully
// ---------------------------------------------------------------------------

describe('Test 1 — Create dialog', () => {
  it('creates a new dialog with INITIATED state and restored=false', () => {
    const dialog = manager.createDialog('dlg-test-1', 'task-aabbccdd');

    expect(dialog.dialog_id).toBe('dlg-test-1');
    expect(dialog.task_id).toBe('task-aabbccdd');
    expect(dialog.state).toBe('INITIATED');
    expect(dialog.restored).toBe(false);
  });

  it('persists the dialog so it can be retrieved', () => {
    manager.createDialog('dlg-test-1b', 'task-xyz');

    const retrieved = manager.getDialog('dlg-test-1b');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.dialog_id).toBe('dlg-test-1b');
    expect(retrieved!.task_id).toBe('task-xyz');
  });

  it('throws ConflictError if dialog_id already exists', () => {
    manager.createDialog('dlg-duplicate', 'task-1');

    expect(() => {
      manager.createDialog('dlg-duplicate', 'task-2');
    }).toThrow(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Retrieve an existing dialog
// ---------------------------------------------------------------------------

describe('Test 2 — Retrieve dialog', () => {
  it('getDialog returns the dialog if it exists', () => {
    manager.createDialog('dlg-get', 'task-123');

    const dialog = manager.getDialog('dlg-get');
    expect(dialog).not.toBeNull();
    expect(dialog!.dialog_id).toBe('dlg-get');
  });

  it('getDialog returns null if dialog does not exist', () => {
    const dialog = manager.getDialog('no-such-dialog');
    expect(dialog).toBeNull();
  });

  it('requireDialog returns the dialog if it exists', () => {
    manager.createDialog('dlg-require', 'task-456');

    const dialog = manager.requireDialog('dlg-require');
    expect(dialog.dialog_id).toBe('dlg-require');
  });

  it('requireDialog throws NotFoundError if dialog does not exist', () => {
    expect(() => {
      manager.requireDialog('missing-dialog');
    }).toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Correlate an existing dialog
// ---------------------------------------------------------------------------

describe('Test 3 — Correlation', () => {
  it('correlates an incoming request to an existing dialog via dialog_id', () => {
    manager.createDialog('dlg-cor-1', 'task-alpha');

    const correlated = manager.correlate('dlg-cor-1', 'task-alpha');
    expect(correlated.dialog_id).toBe('dlg-cor-1');
    expect(correlated.task_id).toBe('task-alpha');
  });

  it('throws NotFoundError if dialog_id does not exist', () => {
    expect(() => {
      manager.correlate('no-such-dialog', 'task-any');
    }).toThrow(NotFoundError);
  });

  it('preserves task_id during correlation', () => {
    manager.createDialog('dlg-cor-2', 'task-beta');

    const correlated = manager.correlate('dlg-cor-2', 'task-beta');
    expect(correlated.task_id).toBe('task-beta');
  });

  it('throws ConflictError if task_id does not match stored task_id', () => {
    manager.createDialog('dlg-cor-3', 'task-original');

    expect(() => {
      manager.correlate('dlg-cor-3', 'task-different');
    }).toThrow(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Correlation uses dialog_id, not seq, not task_id alone
// ---------------------------------------------------------------------------

describe('Test 4 — Correlation identity verification', () => {
  it('two dialogs can have identical task_id without collision', () => {
    // Different dialog_id, same task_id
    manager.createDialog('dlg-a', 'task-shared');
    manager.createDialog('dlg-b', 'task-shared');

    const dialogA = manager.correlate('dlg-a', 'task-shared');
    const dialogB = manager.correlate('dlg-b', 'task-shared');

    expect(dialogA.dialog_id).toBe('dlg-a');
    expect(dialogB.dialog_id).toBe('dlg-b');
    expect(dialogA.task_id).toBe('task-shared');
    expect(dialogB.task_id).toBe('task-shared');
  });

  it('correlation is by dialog_id, not task_id alone', () => {
    manager.createDialog('dlg-x', 'task-1');
    manager.createDialog('dlg-y', 'task-2');

    // Correlating with dlg-x returns task-1, not task-2
    const correlatedX = manager.correlate('dlg-x', 'task-1');
    expect(correlatedX.task_id).toBe('task-1');

    // Correlating with dlg-y returns task-2, not task-1
    const correlatedY = manager.correlate('dlg-y', 'task-2');
    expect(correlatedY.task_id).toBe('task-2');

    // Attempting to correlate dlg-x with task-2 fails
    expect(() => {
      manager.correlate('dlg-x', 'task-2');
    }).toThrow(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Allow every approved valid lifecycle transition
// ---------------------------------------------------------------------------

describe('Test 5 — Valid lifecycle transitions', () => {
  it('INITIATED → PROCESSING', () => {
    manager.createDialog('dlg-t5a', 'task-a');

    const updated = manager.transition('dlg-t5a', 'PROCESSING');
    expect(updated.state).toBe('PROCESSING');
  });

  it('INITIATED → FAILED', () => {
    manager.createDialog('dlg-t5b', 'task-b');

    const updated = manager.transition('dlg-t5b', 'FAILED');
    expect(updated.state).toBe('FAILED');
  });

  it('PROCESSING → COMMITTED', () => {
    manager.createDialog('dlg-t5c', 'task-c');
    manager.transition('dlg-t5c', 'PROCESSING');

    const updated = manager.transition('dlg-t5c', 'COMMITTED');
    expect(updated.state).toBe('COMMITTED');
  });

  it('PROCESSING → RECOVERED', () => {
    manager.createDialog('dlg-t5d', 'task-d');
    manager.transition('dlg-t5d', 'PROCESSING');

    const updated = manager.transition('dlg-t5d', 'RECOVERED');
    expect(updated.state).toBe('RECOVERED');
  });

  it('PROCESSING → FAILED', () => {
    manager.createDialog('dlg-t5e', 'task-e');
    manager.transition('dlg-t5e', 'PROCESSING');

    const updated = manager.transition('dlg-t5e', 'FAILED');
    expect(updated.state).toBe('FAILED');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Reject every invalid lifecycle transition
// ---------------------------------------------------------------------------

describe('Test 6 — Invalid lifecycle transitions', () => {
  it('INITIATED → COMMITTED (invalid)', () => {
    manager.createDialog('dlg-t6a', 'task-a');

    expect(() => {
      manager.transition('dlg-t6a', 'COMMITTED');
    }).toThrow(InvalidTransitionError);
  });

  it('INITIATED → RECOVERED (invalid)', () => {
    manager.createDialog('dlg-t6b', 'task-b');

    expect(() => {
      manager.transition('dlg-t6b', 'RECOVERED');
    }).toThrow(InvalidTransitionError);
  });

  it('PROCESSING → INITIATED (invalid)', () => {
    manager.createDialog('dlg-t6c', 'task-c');
    manager.transition('dlg-t6c', 'PROCESSING');

    expect(() => {
      manager.transition('dlg-t6c', 'INITIATED');
    }).toThrow(InvalidTransitionError);
  });

  it('COMMITTED → PROCESSING (invalid)', () => {
    manager.createDialog('dlg-t6d', 'task-d');
    manager.transition('dlg-t6d', 'PROCESSING');
    manager.transition('dlg-t6d', 'COMMITTED');

    expect(() => {
      manager.transition('dlg-t6d', 'PROCESSING');
    }).toThrow(InvalidTransitionError);
  });

  it('RECOVERED → PROCESSING (invalid)', () => {
    manager.createDialog('dlg-t6e', 'task-e');
    manager.transition('dlg-t6e', 'PROCESSING');
    manager.transition('dlg-t6e', 'RECOVERED');

    expect(() => {
      manager.transition('dlg-t6e', 'PROCESSING');
    }).toThrow(InvalidTransitionError);
  });

  it('FAILED → PROCESSING (invalid)', () => {
    manager.createDialog('dlg-t6f', 'task-f');
    manager.transition('dlg-t6f', 'PROCESSING');
    manager.transition('dlg-t6f', 'FAILED');

    expect(() => {
      manager.transition('dlg-t6f', 'PROCESSING');
    }).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Prevent state mutation after terminal states
// ---------------------------------------------------------------------------

describe('Test 7 — Terminal states', () => {
  it('COMMITTED cannot transition to any state', () => {
    manager.createDialog('dlg-t7a', 'task-a');
    manager.transition('dlg-t7a', 'PROCESSING');
    manager.transition('dlg-t7a', 'COMMITTED');

    expect(() => manager.transition('dlg-t7a', 'PROCESSING')).toThrow(InvalidTransitionError);
    expect(() => manager.transition('dlg-t7a', 'FAILED')).toThrow(InvalidTransitionError);
    expect(() => manager.transition('dlg-t7a', 'RECOVERED')).toThrow(InvalidTransitionError);
  });

  it('RECOVERED cannot transition to any state', () => {
    manager.createDialog('dlg-t7b', 'task-b');
    manager.transition('dlg-t7b', 'PROCESSING');
    manager.transition('dlg-t7b', 'RECOVERED');

    expect(() => manager.transition('dlg-t7b', 'PROCESSING')).toThrow(InvalidTransitionError);
    expect(() => manager.transition('dlg-t7b', 'COMMITTED')).toThrow(InvalidTransitionError);
    expect(() => manager.transition('dlg-t7b', 'FAILED')).toThrow(InvalidTransitionError);
  });

  it('FAILED cannot transition to any state', () => {
    manager.createDialog('dlg-t7c', 'task-c');
    manager.transition('dlg-t7c', 'FAILED');

    expect(() => manager.transition('dlg-t7c', 'PROCESSING')).toThrow(InvalidTransitionError);
    expect(() => manager.transition('dlg-t7c', 'COMMITTED')).toThrow(InvalidTransitionError);
    expect(() => manager.transition('dlg-t7c', 'RECOVERED')).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Mark a dialog as restored
// ---------------------------------------------------------------------------

describe('Test 8 — Mark restored', () => {
  it('markRestored sets restored flag to true', () => {
    manager.createDialog('dlg-t8a', 'task-a');

    const updated = manager.markRestored('dlg-t8a');
    expect(updated.restored).toBe(true);
  });

  it('markRestored preserves current state', () => {
    manager.createDialog('dlg-t8b', 'task-b');
    manager.transition('dlg-t8b', 'PROCESSING');

    const updated = manager.markRestored('dlg-t8b');
    expect(updated.state).toBe('PROCESSING');
    expect(updated.restored).toBe(true);
  });

  it('markRestored throws NotFoundError if dialog does not exist', () => {
    expect(() => {
      manager.markRestored('no-such-dialog');
    }).toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Test 9: Verify restored state persists through the repository
// ---------------------------------------------------------------------------

describe('Test 9 — Restored persistence', () => {
  it('restored flag survives close/reopen', () => {
    const PERSIST_DB = tempDbPath('restored-persist');
    try {
      // Step 1: Create dialog, mark restored, close
      const handle1 = openDatabase(PERSIST_DB, SQL);
      const manager1 = new DialogManager(handle1.db, PERSIST_DB);

      manager1.createDialog('dlg-restored-persist', 'task-1');
      manager1.markRestored('dlg-restored-persist');

      // Verify before close
      expect(manager1.getDialog('dlg-restored-persist')!.restored).toBe(true);

      closeDatabase(handle1.db);

      // Step 2: Reopen, verify restored flag survived
      const handle2 = openDatabase(PERSIST_DB, SQL);
      const manager2 = new DialogManager(handle2.db, PERSIST_DB);

      const reloaded = manager2.getDialog('dlg-restored-persist');
      expect(reloaded).not.toBeNull();
      expect(reloaded!.restored).toBe(true);
      expect(reloaded!.task_id).toBe('task-1');

      closeDatabase(handle2.db);
    } finally {
      if (fs.existsSync(PERSIST_DB)) fs.unlinkSync(PERSIST_DB);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 10: Verify task identity remains unchanged after state transitions
// ---------------------------------------------------------------------------

describe('Test 10 — Task identity preservation', () => {
  it('task_id does not change during lifecycle transitions', () => {
    manager.createDialog('dlg-t10', 'task-immutable');

    expect(manager.getDialog('dlg-t10')!.task_id).toBe('task-immutable');

    manager.transition('dlg-t10', 'PROCESSING');
    expect(manager.getDialog('dlg-t10')!.task_id).toBe('task-immutable');

    manager.transition('dlg-t10', 'COMMITTED');
    expect(manager.getDialog('dlg-t10')!.task_id).toBe('task-immutable');
  });

  it('task_id does not change when marking restored', () => {
    manager.createDialog('dlg-t10b', 'task-sticky');
    manager.markRestored('dlg-t10b');

    expect(manager.getDialog('dlg-t10b')!.task_id).toBe('task-sticky');
  });

  it('task_id does not change during combined transitionToRecovered', () => {
    manager.createDialog('dlg-t10c', 'task-stable');
    manager.transition('dlg-t10c', 'PROCESSING');
    manager.transitionToRecovered('dlg-t10c');

    const dialog = manager.getDialog('dlg-t10c')!;
    expect(dialog.task_id).toBe('task-stable');
    expect(dialog.state).toBe('RECOVERED');
    expect(dialog.restored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 11: getActiveDialogs for recovery
// ---------------------------------------------------------------------------

describe('Test 11 — Get active dialogs', () => {
  it('returns only non-terminal dialogs', () => {
    manager.createDialog('dlg-active-1', 'task-1');  // INITIATED
    manager.createDialog('dlg-active-2', 'task-2');
    manager.transition('dlg-active-2', 'PROCESSING');  // PROCESSING

    manager.createDialog('dlg-committed', 'task-3');
    manager.transition('dlg-committed', 'PROCESSING');
    manager.transition('dlg-committed', 'COMMITTED');  // terminal

    manager.createDialog('dlg-failed', 'task-4');
    manager.transition('dlg-failed', 'FAILED');  // terminal

    const active = manager.getActiveDialogs();
    const activeIds = active.map((d) => d.dialog_id);

    expect(activeIds).toContain('dlg-active-1');
    expect(activeIds).toContain('dlg-active-2');
    expect(activeIds).not.toContain('dlg-committed');
    expect(activeIds).not.toContain('dlg-failed');
  });
});

// ---------------------------------------------------------------------------
// Test 12: transitionToRecovered convenience method
// ---------------------------------------------------------------------------

describe('Test 12 — transitionToRecovered', () => {
  it('transitions to RECOVERED and sets restored flag in one operation', () => {
    manager.createDialog('dlg-t12', 'task-recover');
    manager.transition('dlg-t12', 'PROCESSING');

    const updated = manager.transitionToRecovered('dlg-t12');

    expect(updated.state).toBe('RECOVERED');
    expect(updated.restored).toBe(true);
  });

  it('throws InvalidTransitionError if transition to RECOVERED is invalid', () => {
    manager.createDialog('dlg-t12b', 'task-b');

    // Cannot go directly from INITIATED to RECOVERED
    expect(() => {
      manager.transitionToRecovered('dlg-t12b');
    }).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Test 13: dialog_id uniqueness
// ---------------------------------------------------------------------------

describe('Test 13 — dialog_id uniqueness', () => {
  it('dialog_id must be unique across all dialogs', () => {
    manager.createDialog('dlg-unique', 'task-1');

    expect(() => {
      manager.createDialog('dlg-unique', 'task-2');
    }).toThrow(ConflictError);
  });
});
