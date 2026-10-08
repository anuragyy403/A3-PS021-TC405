/**
 * PS-021 — Nighthawks backend type definitions.
 *
 * These types are the authoritative source of truth for the backend.
 * The frontend uses a 6-state model that includes WAITING_ACK for UI
 * quiescence detection; the backend deliberately omits that state.
 *
 * IMPORTANT: Do not add WAITING_ACK to LifecycleState. It is a
 * frontend-only presentation concept and must not leak into the
 * backend architecture.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * The five authoritative lifecycle states for the backend.
 *
 * Non-terminal:
 *   INITIATED  — dialog created, no request has been processed yet
 *   PROCESSING — at least one request processed, work still ongoing
 *
 * Terminal (no outgoing transitions):
 *   COMMITTED  — task completed successfully, no crash occurred
 *   RECOVERED  — task completed successfully after Adapter A restart
 *   FAILED     — task could not complete (unrecoverable gap or error)
 *
 * Transition table (enforced by DialogManager, defined here for reference):
 *   INITIATED  → PROCESSING | FAILED
 *   PROCESSING → COMMITTED  | RECOVERED | FAILED
 *   COMMITTED  → (none)
 *   RECOVERED  → (none)
 *   FAILED     → (none)
 */
export const LIFECYCLE_STATES = [
  'INITIATED',
  'PROCESSING',
  'COMMITTED',
  'RECOVERED',
  'FAILED',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set([
  'COMMITTED',
  'RECOVERED',
  'FAILED',
]);

export const VALID_TRANSITIONS: Record<LifecycleState, ReadonlyArray<LifecycleState>> = {
  INITIATED:  ['PROCESSING', 'FAILED'],
  PROCESSING: ['COMMITTED', 'RECOVERED', 'FAILED'],
  COMMITTED:  [],
  RECOVERED:  [],
  FAILED:     [],
};

export function isTerminal(state: LifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return (VALID_TRANSITIONS[from] as LifecycleState[]).includes(to);
}

// ---------------------------------------------------------------------------
// Zod schemas — used for runtime validation at API boundaries
// ---------------------------------------------------------------------------

export const LifecycleStateSchema = z.enum([
  'INITIATED',
  'PROCESSING',
  'COMMITTED',
  'RECOVERED',
  'FAILED',
]);

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

/**
 * A dialog is a bounded exchange between two agents about a piece of work.
 *
 * dialog_id: primary correlation key
 * task_id:   identifies the unit of work; must survive adapter restart (R3)
 * state:     current lifecycle state
 * restored:  true when this dialog was reloaded from SQLite after a crash
 */
export interface DialogRecord {
  dialog_id:  string;
  task_id:    string;
  state:      LifecycleState;
  restored:   boolean;
}

export const DialogRecordSchema = z.object({
  dialog_id:  z.string().min(1),
  task_id:    z.string().min(1),
  state:      LifecycleStateSchema,
  restored:   z.boolean(),
});

// ---------------------------------------------------------------------------
// Request record
// ---------------------------------------------------------------------------

/**
 * A request record represents one processed request within a dialog.
 *
 * The deduplication key is (dialog_id, seq).  Two different dialogs can
 * safely reuse the same seq number; the dialog_id scopes them.
 *
 * seq:    sequence number = logical request identity within the dialog.
 *         A retry of the same request carries the same seq.  Only the
 *         attempt counter changes on retry.
 *
 * result: JSON-serialised result stored so a duplicate response can be
 *         returned from the ledger rather than re-executing the side effect.
 */
export interface RequestRecord {
  dialog_id:    string;
  seq:          number;
  processed_at: string; // ISO 8601
  result:       string; // JSON string
}

export const RequestRecordSchema = z.object({
  dialog_id:    z.string().min(1),
  seq:          z.number().int().positive(),
  processed_at: z.string(),
  result:       z.string(),
});

// ---------------------------------------------------------------------------
// Transition history entry (runtime-only, not persisted in this phase)
// ---------------------------------------------------------------------------

export interface TransitionEntry {
  from:   LifecycleState | null;
  to:     LifecycleState;
  reason: string;
  at:     string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Standard API error shape
// ---------------------------------------------------------------------------

export interface ApiError {
  error:   string;
  message: string;
  status:  number;
}
