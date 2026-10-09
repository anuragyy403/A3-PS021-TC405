/**
 * Tests for scripts/trace.mjs formatting.   node scripts/trace.test.mjs
 *
 * Uses REAL backend events captured in Front/frontend/tests/fixtures/events.json
 * and checks that every type in backend/src/runtime/EventLog.ts is mapped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMATTED_TYPES, formatEvents, shortId } from './trace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const events = JSON.parse(readFileSync(path.join(ROOT, 'Front', 'frontend', 'tests', 'fixtures', 'events.json'), 'utf8')).events;
const eventLogSource = readFileSync(path.join(ROOT, 'backend', 'src', 'runtime', 'EventLog.ts'), 'utf8');
const BACKEND_TYPES = [...eventLogSource.slice(eventLogSource.indexOf('EVENT_TYPES = ['), eventLogSource.indexOf('] as const'))
  .matchAll(/'(\w+)'/g)].map((m) => m[1]);

const results = [];
function test(label, fn) {
  try {
    fn();
    results.push(true);
    console.log(`PASS  ${label}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL  ${label}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}
const one = (type, pick = () => true) => events.find((e) => e.type === type && pick(e));
const line = (event) => formatEvents([event], { time: false })[0];

test('every backend event type has a formatter (and nothing extra)', () => {
  assert.equal(BACKEND_TYPES.length, 18);
  assert.deepEqual([...FORMATTED_TYPES].sort(), [...BACKEND_TYPES].sort());
});

test('every captured event formats without falling back to raw output', () => {
  const lines = formatEvents(events, { time: false });
  assert.ok(lines.length > 50, `${lines.length} lines`);
  assert.ok(lines.every((l) => !l.startsWith('[?]')), lines.find((l) => l.startsWith('[?]')));
});

test('the key lines of the story read as intended', () => {
  const created = one('dialog_created');
  assert.equal(line(created), `[A]    startDialog task_id=${created.task_id} → dialog_id=${created.dialog_id} INITIATED`);
  const sent = one('request_sent');
  assert.equal(line(sent), `[A]    send seq=${sent.seq} → send log PENDING   (${shortId(sent.dialog_id)})`);
  const lostReply = one('response_dropped');
  assert.equal(line(lostReply), `[net]  reply for seq ${lostReply.seq} LOST — B already did the work (B status ok)   (${shortId(lostReply.dialog_id)})`);
  const lostReq = one('request_dropped');
  assert.match(line(lostReq), /^\[net\] {2}request for seq \d+ LOST — B never saw it/);
  const retry = one('retry_sent');
  assert.match(line(retry), new RegExp(`^\\[A\\] {4}retry seq=${retry.seq} \\(attempt ${retry.details.attempts}\\)`));
  const dup = one('duplicate_suppressed');
  assert.equal(line(dup), `[B]    (${shortId(dup.dialog_id)},${dup.seq}) already processed → DUPLICATE, work NOT repeated, stored answer returned${dup.details.terminal ? ' (dialog finished)' : ''}`);
  const restart = one('adapter_restarted', (e) => e.details.phase !== 'end');
  assert.equal(line(restart), `[rt]   PROCESS RESTART (target ${restart.details.target}) — both adapters rebuilt from the SQLite file`);
  const rec = one('dialog_recovered');
  assert.equal(line(rec), `[A]    recovered ${rec.dialog_id} task_id=${rec.task_id} state=${rec.details.state} next_seq=${rec.details.next_seq} pending=[${rec.details.pending_seqs.join(',')}]`);
});

test('B processing and its INITIATED → PROCESSING transition fold into one line', () => {
  const i = events.findIndex((e, k) => e.type === 'request_processed' && events[k + 1]?.type === 'state_transition' && events[k + 1].actor === 'B');
  assert.ok(i >= 0, 'fixture has the pair');
  const [first, ...rest] = formatEvents(events.slice(i, i + 2), { time: false });
  assert.equal(rest.length, 0);
  assert.match(first, /new → processed \(processed_count=1\); INITIATED → PROCESSING$/);
});

test('passing checks are not repeated (their PASS step is), failing ones are', () => {
  const pass = one('scenario_assertion', (e) => e.details.ok);
  assert.deepEqual(formatEvents([pass]), []);
  assert.equal(line({ ...pass, details: { ...pass.details, ok: false, label: 'x', detail: 'y' } }), '[demo]   ✗ x — y');
});

test('unknown types print raw; clock column is local HH:MM:SS.mmm', () => {
  const odd = { id: 9, at: '2026-10-09T05:00:00.000Z', type: 'something_new', actor: 'runtime' };
  assert.equal(line(odd), `[?]    ${JSON.stringify(odd)}`);
  assert.match(formatEvents([odd])[0], /^\d{2}:\d{2}:\d{2}\.\d{3} \[\?\]/);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
