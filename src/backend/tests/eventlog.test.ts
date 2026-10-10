/**
 * Phase 6a — EventLog ring buffer (docs/API_DESIGN.md §6.2–§6.3).
 */

import { describe, it, expect } from 'vitest';

import { EventLog, EVENT_TYPES, DEFAULT_PAGE_LIMIT } from '../src/runtime/EventLog.js';
import type { NewEvent } from '../src/runtime/EventLog.js';

function ev(seq: number): NewEvent {
  return { type: 'request_sent', actor: 'A', dialog_id: 'D1', seq };
}

describe('EventLog', () => {
  it('declares exactly the event types of API_DESIGN §6.3', () => {
    expect([...EVENT_TYPES].sort()).toEqual([
      'adapter_restarted', 'dialog_created', 'dialog_recovered', 'duplicate_suppressed',
      'request_acked', 'request_dropped', 'request_processed', 'request_rejected',
      'request_sent', 'response_delivered', 'response_dropped', 'retry_sent',
      'runtime_reset', 'scenario_assertion', 'scenario_finished', 'scenario_started',
      'scenario_step', 'state_transition',
    ]);
  });

  it('assigns increasing ids and ISO timestamps, preserving order', () => {
    const log = new EventLog(10);
    const a = log.append(ev(1));
    const b = log.append(ev(2));

    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(new Date(a.at).toISOString()).toBe(a.at);
    expect(log.since(0).events.map(e => e.seq)).toEqual([1, 2]);
    expect(log.latestId).toBe(2);
  });

  it('since(cursor) returns only newer events and advances the cursor', () => {
    const log = new EventLog(10);
    for (let i = 1; i <= 5; i++) log.append(ev(i));

    const page = log.since(3);
    expect(page.events.map(e => e.id)).toEqual([4, 5]);
    expect(page.cursor).toBe(5);
    expect(page.truncated).toBe(false);

    const empty = log.since(5);
    expect(empty.events).toEqual([]);
    expect(empty.cursor).toBe(5);  // unchanged when nothing new
  });

  it('since() respects limit (oldest first) and defaults to DEFAULT_PAGE_LIMIT', () => {
    const log = new EventLog(500);
    for (let i = 1; i <= 250; i++) log.append(ev(i));

    const page = log.since(0, 3);
    expect(page.events.map(e => e.id)).toEqual([1, 2, 3]);
    expect(page.cursor).toBe(3);

    expect(log.since(0).events).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(log.since(0, 0).events).toHaveLength(1);  // limit clamps to ≥ 1
  });

  it('evicts oldest first at capacity; ids keep increasing; truncated flags the gap', () => {
    const log = new EventLog(3);
    for (let i = 1; i <= 5; i++) log.append(ev(i));

    expect(log.size).toBe(3);
    expect(log.oldestId).toBe(3);

    const page = log.since(0);
    expect(page.events.map(e => e.id)).toEqual([3, 4, 5]);
    expect(page.oldest_available).toBe(3);
    expect(page.truncated).toBe(true);    // ids 1–2 were evicted

    expect(log.since(2).truncated).toBe(false);  // nothing missed after id 2
    expect(log.append(ev(6)).id).toBe(6);
  });

  it('clear() empties the buffer, switches epoch, and keeps ids increasing', () => {
    const log = new EventLog(10);
    const epoch1 = log.epoch;
    log.append(ev(1));
    log.append(ev(2));

    log.clear();

    expect(log.epoch).not.toBe(epoch1);
    expect(log.size).toBe(0);
    const page = log.since(1);
    expect(page.events).toEqual([]);
    expect(page.truncated).toBe(true);    // a client at cursor 1 missed event 2
    expect(page.epoch).toBe(log.epoch);
    expect(log.append(ev(3)).id).toBe(3);
  });

  it('a fresh log at cursor 0 is not truncated', () => {
    expect(new EventLog(5).since(0)).toMatchObject({ events: [], cursor: 0, truncated: false, oldest_available: 1 });
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new EventLog(0)).toThrow(RangeError);
    expect(() => new EventLog(Number.NaN)).toThrow(RangeError);
  });
});
