/**
 * EventLog — in-memory activity feed for the HTTP API (docs/API_DESIGN.md §6).
 *
 * A bounded ring buffer of ApiEvents with monotonically increasing integer
 * ids.  Clients poll with `since(cursor)`.  When the buffer is full the
 * oldest event is evicted; ids never restart, so a cursor stays meaningful.
 *
 * NOT durable: the buffer lives in the SimulationRuntime, survives simulated
 * adapter restarts, and is lost when the Node process exits.  `clear()` (used
 * by the demo reset) empties it and changes the epoch so clients know to drop
 * their cursor.  The durable truth is the SQLite tables, not these events.
 */

import { randomBytes } from 'node:crypto';

export const EVENT_TYPES = [
  'dialog_created',
  'request_sent',
  'retry_sent',
  'request_dropped',
  'request_processed',
  'duplicate_suppressed',
  'request_rejected',
  'response_delivered',
  'response_dropped',
  'request_acked',
  'state_transition',
  'adapter_restarted',
  'dialog_recovered',
  'scenario_started',
  'scenario_step',
  'scenario_assertion',
  'scenario_finished',
  'runtime_reset',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventActor = 'A' | 'B' | 'transport' | 'runtime' | 'scenario';

export interface ApiEvent {
  id:         number;                    // cursor
  at:         string;                    // ISO 8601
  type:       EventType;
  actor:      EventActor;
  dialog_id?: string;
  task_id?:   string;
  seq?:       number;
  outcome?:   string;
  details?:   Record<string, unknown>;
}

/** What a producer supplies; id and timestamp are assigned by the log. */
export type NewEvent = Omit<ApiEvent, 'id' | 'at'>;

export interface EventPage {
  epoch:            string;
  events:           ApiEvent[];
  cursor:           number;   // id of the last returned event, or the input cursor
  oldest_available: number;   // id of the oldest retained event (latestId + 1 when empty)
  truncated:        boolean;  // true when events after `cursor` were evicted or cleared
}

export const DEFAULT_PAGE_LIMIT = 200;

export function newEpoch(): string {
  return `ep-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export class EventLog {
  private readonly capacity: number;
  private buffer: ApiEvent[] = [];
  private lastId = 0;
  private currentEpoch: string;

  constructor(capacity: number, epoch: string = newEpoch()) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`event buffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity     = capacity;
    this.currentEpoch = epoch;
  }

  get epoch(): string {
    return this.currentEpoch;
  }

  /** Id of the most recently appended event (0 if none ever). */
  get latestId(): number {
    return this.lastId;
  }

  /** Id of the oldest retained event, or latestId + 1 when the buffer is empty. */
  get oldestId(): number {
    return this.buffer.length > 0 ? this.buffer[0]!.id : this.lastId + 1;
  }

  get size(): number {
    return this.buffer.length;
  }

  append(event: NewEvent): ApiEvent {
    const stored: ApiEvent = { id: ++this.lastId, at: new Date().toISOString(), ...event };
    this.buffer.push(stored);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();  // evict oldest
    }
    return stored;
  }

  /**
   * Events with id > cursor, oldest first, at most `limit` of them.
   *
   * `truncated` is the "you missed something" signal: events between the
   * cursor and the oldest retained one were evicted (or cleared by reset).
   */
  since(cursor = 0, limit = DEFAULT_PAGE_LIMIT): EventPage {
    const max    = Math.max(1, Math.floor(limit));
    const events = this.buffer.filter(e => e.id > cursor).slice(0, max);

    return {
      epoch:            this.currentEpoch,
      events,
      cursor:           events.length > 0 ? events[events.length - 1]!.id : cursor,
      oldest_available: this.oldestId,
      truncated:        cursor < this.oldestId - 1,
    };
  }

  /** Empty the buffer and switch to a new epoch.  Ids keep increasing. */
  clear(epoch: string = newEpoch()): void {
    this.buffer       = [];
    this.currentEpoch = epoch;
  }
}
