/**
 * Mapper tests (Phase 7a): backend API JSON → dashboard contract.
 *
 *   node tests/mappers.mjs
 *
 * Fixtures in tests/fixtures/ are REAL backend responses captured with
 * tests/capture-fixtures.mjs.  Plain node + node:assert, same reporting style
 * as tests/conformance.mjs.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  LOG_CAP,
  OFFLINE_NODES,
  appendCapped,
  createdAtFromId,
  dirtyDialogIds,
  emptyMetrics,
  idleSimulation,
  mapDialogView,
  mapEventToLog,
  mapEventToWire,
  mapLedger,
  mapLedgerStatus,
  mapMetrics,
  mapNodes,
  mapScenarioProgress,
  mapScenarioResult,
  mapScenarioResults,
  mapState,
  noticeLog,
  resolveEventPage,
  scenarioRunIdFromEvents,
} from '../src/api/mappers.js';
import { selectEngine } from '../src/api/engine.js';
import { describeTask, narrate } from '../src/lib/narrate.js';
import { LAYERS, LOG_KINDS } from '../src/lib/constants.js';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

const root = process.cwd();
const fixture = async (name) => JSON.parse(await readFile(join(root, 'tests', 'fixtures', name), 'utf8'));

const state = await fixture('state.json');
const detail = await fixture('dialog-detail.json');
const events = (await fixture('events.json')).events;
const s1 = await fixture('scenario-result-1.json');
const s4 = await fixture('scenario-result-4.json');
const scenarios = await fixture('scenarios.json');

/** Wire phases usePacketLayer.js actually knows how to draw. */
/** Source text with CRLF normalised, so the slicing below works on any checkout. */
const sourceOf = async (...parts) => (await readFile(join(root, ...parts), 'utf8')).replace(/\r\n/g, '\n');

const packetSource = await sourceOf('src', 'components', 'usePacketLayer.js');
const KNOWN_PHASES = new Set(
  [...packetSource.slice(packetSource.indexOf('const PHASE_VISUALS'), packetSource.indexOf('};', packetSource.indexOf('const PHASE_VISUALS')))
    .matchAll(/^\s+(\w+):\s*\{/gm)].map((m) => m[1]),
);

/** Field names of the old engine's toView() (the contract TaskList & co. read). */
const engineSource = await sourceOf('src', 'lib', 'useCorrelationEngine.js');
const toViewBody = engineSource.slice(engineSource.indexOf('function toView'), engineSource.indexOf('\n}\n', engineSource.indexOf('function toView')));
const TOVIEW_FIELDS = [...toViewBody.slice(toViewBody.indexOf('return {')).matchAll(/^\s{4}(\w+)[:,]/gm)].map((m) => m[1]);
const metricsBody = engineSource.slice(engineSource.indexOf('function computeMetrics'));
const METRIC_FIELDS = [...metricsBody.slice(metricsBody.indexOf('return {'), metricsBody.indexOf('};')).matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);

const results = [];
function test(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
    console.log(`${GREEN}PASS${RESET}  ${label}`);
  } catch (error) {
    results.push({ label, ok: false });
    console.log(`${RED}FAIL${RESET}  ${label}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

console.log(`\n${BOLD}Nighthawks - backend mapper tests${RESET}\n`);

// ---------------------------------------------------------------------------
// Metrics (DECISION 6)
// ---------------------------------------------------------------------------

test('metrics: every old-engine metric field exists in the mapped object', () => {
  assert.ok(METRIC_FIELDS.length >= 15, `parsed ${METRIC_FIELDS.length} fields`);
  const mapped = mapMetrics(state.metrics, state.runtime);
  for (const f of METRIC_FIELDS) assert.ok(f in mapped, `missing ${f}`);
});

test('metrics: counters come from the documented backend fields', () => {
  const m = state.metrics;
  const by = m.by_state;
  const mapped = mapMetrics(m, state.runtime);
  assert.equal(mapped.sideEffects, m.processed_count);
  assert.equal(mapped.packets, m.transport_attempts);
  assert.equal(mapped.dedup, m.duplicates_since_boot);
  assert.equal(mapped.suppressed, m.duplicates_since_boot);
  assert.equal(mapped.recoveryAttempted, m.restored_total);
  assert.equal(mapped.recoverySucceeded, by.RECOVERED);
  assert.equal(mapped.recovered, by.RECOVERED);
  assert.equal(mapped.committed, by.COMMITTED);
  assert.equal(mapped.failed, by.FAILED);
  assert.equal(mapped.activeDialogs, by.INITIATED + by.PROCESSING);
  assert.equal(mapped.totalDialogs, m.dialogs_total);
  assert.equal(mapped.durableDialogs, m.dialogs_total);
  assert.equal(mapped.uptimeMs, state.runtime.uptime_ms);
  assert.equal(mapped.bootAt, Date.parse(state.runtime.booted_at));
  assert.equal(mapped.recoveryRate, m.restored_total ? (by.RECOVERED / m.restored_total) * 100 : null);
});

test('metrics: fields with no backend source are zero/null, never invented', () => {
  const mapped = mapMetrics(state.metrics, state.runtime);
  assert.equal(mapped.buffered, 0);
  assert.equal(mapped.pps, 0);
  assert.equal(mapped.peakPps, 0);
  assert.equal(mapped.walLsn, 0);
  assert.equal(mapped.avgLatencyMs, null);
  assert.deepEqual(mapMetrics(undefined), emptyMetrics());
  assert.equal(emptyMetrics().recoveryRate, null);   // MetricBar shows its "100%" empty state
});

test('metrics: recovery rate is null when nothing was restored', () => {
  const m = { ...state.metrics, restored_total: 0, by_state: { ...state.metrics.by_state, RECOVERED: 0 } };
  assert.equal(mapMetrics(m, state.runtime).recoveryRate, null);
});

// ---------------------------------------------------------------------------
// Nodes (DECISION 7)
// ---------------------------------------------------------------------------

test('nodes: adapterA/adapterB/storage from state, bridge ← transport', () => {
  const n = mapNodes(state.nodes);
  assert.deepEqual(Object.keys(n).sort(), ['adapterA', 'adapterB', 'bridge', 'storage']);
  for (const k of Object.keys(n)) assert.equal(n[k].status, 'online');
  const r = mapNodes({ ...state.nodes, transport: { status: 'restarting' }, adapterA: { status: 'restarting' } });
  assert.equal(r.bridge.status, 'booting');
  assert.equal(r.adapterA.status, 'booting');
});

test('nodes: unreachable backend → every node offline', () => {
  for (const n of Object.values(mapNodes(undefined))) assert.equal(n.status, 'offline');
  for (const n of Object.values(OFFLINE_NODES)) assert.equal(n.status, 'offline');
});

// ---------------------------------------------------------------------------
// Dialogs and ledgers
// ---------------------------------------------------------------------------

test('ledger: backend statuses map onto statuses TaskList renders', () => {
  assert.equal(mapLedgerStatus('acked'), 'applied');
  assert.equal(mapLedgerStatus('processed_unacked'), 'applied');
  assert.equal(mapLedgerStatus('pending_unprocessed'), 'missing');
  assert.equal(mapLedgerStatus('something-new'), 'pending');
  const ledger = mapLedger(detail);
  assert.deepEqual(detail.ledger.map((r) => r.status), ['acked', 'processed_unacked', 'pending_unprocessed']);
  assert.deepEqual(ledger.map((r) => r.status), ['applied', 'applied', 'missing']);
  assert.deepEqual(ledger.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(mapLedger(undefined), []);
});

test('dialog view: every toView() field exists, values from the summary/detail', () => {
  assert.ok(TOVIEW_FIELDS.length >= 20, `parsed ${TOVIEW_FIELDS.length} fields`);
  const view = mapDialogView(detail.dialog, detail);
  for (const f of TOVIEW_FIELDS) assert.ok(f in view, `missing ${f}`);
  assert.equal(view.id, detail.dialog.dialog_id);
  assert.equal(view.taskId, 'task-fixture');
  assert.equal(view.state, 'PROCESSING');
  assert.equal(view.sideEffects, detail.dialog.processed_count);
  assert.equal(view.appliedCount, 2);
  assert.deepEqual(view.appliedOrder, [1, 2]);
  assert.equal(view.nextSeq, 4);
  assert.deepEqual(view.pendingSeqs, [2, 3]);
  assert.deepEqual(view.buffered, []);
  assert.deepEqual(view.missing, []);
  assert.equal(view.settled, false);
  assert.equal(view.protocol, null);
  assert.equal(view.envelope, null);
  assert.equal(view.createdAt, createdAtFromId(view.id));
});

test('dialog view: works without a detail (empty ledger) and describeTask accepts it', () => {
  for (const summary of state.dialogs) {
    const view = mapDialogView(summary);
    assert.deepEqual(view.ledger, []);
    assert.equal(typeof describeTask(view), 'string');
  }
});

test('createdAtFromId parses dlg-<ms>- ids and rejects others', () => {
  assert.equal(createdAtFromId('dlg-1791460800000-k3f9q2a'), 1791460800000);
  assert.equal(createdAtFromId('something'), null);
  assert.equal(createdAtFromId(undefined), null);
});

test('state: dialogs, metrics, nodes, busy, running scenario, epoch', () => {
  const mapped = mapState(state, new Map([[detail.dialog.dialog_id, detail]]));
  assert.equal(mapped.dialogs.length, state.dialogs.length);
  const withDetail = mapped.dialogs.find((d) => d.id === detail.dialog.dialog_id);
  assert.equal(withDetail.ledger.length, 3);
  assert.equal(mapped.busy, false);
  assert.equal(mapped.runningScenario, null);
  assert.equal(mapped.epoch, state.runtime.epoch);
  const states = new Set(mapped.dialogs.map((d) => d.state));
  for (const s of ['COMMITTED', 'RECOVERED', 'FAILED', 'INITIATED', 'PROCESSING']) assert.ok(states.has(s), `fixture lacks ${s}`);
  assert.equal(mapped.metrics.sideEffects, state.dialogs.reduce((n, d) => n + d.processed_count, 0));
});

// ---------------------------------------------------------------------------
// Events → logs
// ---------------------------------------------------------------------------

const BACKEND_TYPES = [
  'dialog_created', 'request_sent', 'retry_sent', 'request_dropped', 'request_processed',
  'duplicate_suppressed', 'request_rejected', 'response_delivered', 'response_dropped',
  'request_acked', 'state_transition', 'adapter_restarted', 'dialog_recovered',
  'scenario_started', 'scenario_step', 'scenario_assertion', 'scenario_finished', 'runtime_reset',
];

test('fixture covers every backend event type', () => {
  const seen = new Set(events.map((e) => e.type));
  for (const t of BACKEND_TYPES) assert.ok(seen.has(t), `fixture lacks ${t}`);
});

test('logs: every event maps to a valid entry (or is deliberately omitted)', () => {
  const layers = new Set(Object.keys(LAYERS));
  for (const e of events) {
    const entry = mapEventToLog(e);
    if (e.type === 'scenario_assertion') { assert.equal(entry, null); continue; }
    assert.ok(entry, `no entry for ${e.type}`);
    assert.equal(entry.id, e.id);
    assert.ok(LOG_KINDS.includes(entry.kind), `${e.type}: kind ${entry.kind}`);
    assert.ok(layers.has(entry.layer), `${e.type}: layer ${entry.layer}`);
    assert.equal(entry.dialogId, e.dialog_id ?? '-');
    assert.equal(typeof entry.msg, 'string');
    assert.ok(entry.msg.length > 0);
    assert.equal(entry.meta.event_type, e.type);
    assert.equal(entry.at, Date.parse(e.at));
    assert.match(entry.clock, /^\d{2}:\d{2}:\d{2}/);
    const spoken = narrate(entry);
    assert.equal(typeof spoken.headline, 'string');
  }
});

function first(type, pred = () => true) {
  const e = events.find((x) => x.type === type && pred(x));
  assert.ok(e, `no ${type} in fixture`);
  return e;
}

test('logs: narration of mapped events is accurate', () => {
  const sent = first('request_sent');
  assert.equal(narrate(mapEventToLog(sent)).headline, `Sending packet ${sent.seq} to the Receiver Agent`);

  const processed = first('request_processed');
  const p = narrate(mapEventToLog(processed));
  assert.equal(p.headline, `Packet ${processed.seq} received and processed`);
  assert.match(p.detail, new RegExp(`Work item ${processed.details.processed_count} completed`));

  const dup = first('duplicate_suppressed');
  assert.equal(narrate(mapEventToLog(dup)).headline, `Duplicate of packet ${dup.seq} blocked`);
  assert.equal(mapEventToLog(dup).kind, 'duplicate');

  const lost = first('request_dropped');
  assert.equal(mapEventToLog(lost).kind, 'error');
  assert.match(narrate(mapEventToLog(lost)).headline, /^Packet \d+ was lost/);

  const recovered = first('dialog_recovered');
  const r = narrate(mapEventToLog(recovered));
  assert.equal(r.headline, 'Unfinished task reloaded from the database');
  assert.match(r.detail, new RegExp(`at packet ${recovered.details.next_seq}\\.`));

  const created = first('dialog_created');
  assert.equal(narrate(mapEventToLog(created)).headline, 'New task started');

  const commit = first('state_transition', (e) => e.details.to === 'COMMITTED');
  assert.equal(narrate(mapEventToLog(commit)).headline, 'Task is now: Completed');
  const fail = first('state_transition', (e) => e.details.to === 'FAILED');
  assert.equal(mapEventToLog(fail).kind, 'error');
});

test('logs: restarts are narrated as a full process restart, never "Sender Agent" only', () => {
  for (const e of events.filter((x) => x.type === 'adapter_restarted')) {
    const entry = mapEventToLog(e);
    assert.match(entry.msg, /scope process/);
    assert.match(entry.msg, /both adapter/);
    const spoken = narrate(entry);
    assert.equal(spoken.headline, entry.msg, 'must fall through to the verbatim message');
    assert.doesNotMatch(spoken.headline, /Sender Agent/);
  }
});

test('logs: response_dropped / rejected / retry fall through to their verbatim message', () => {
  for (const type of ['response_dropped', 'request_rejected', 'retry_sent', 'request_acked', 'response_delivered']) {
    const entry = mapEventToLog(first(type));
    assert.equal(narrate(entry).headline, entry.msg, type);
  }
  assert.match(mapEventToLog(first('request_rejected')).msg, /DIALOG_TERMINAL/);
});

test('logs: unknown and malformed events never crash', () => {
  const unknown = mapEventToLog({ id: 999, at: '2026-10-08T00:00:00.000Z', type: 'brand_new_type', actor: 'martian' });
  assert.equal(unknown.kind, 'success');
  assert.equal(unknown.layer, 'control');
  assert.match(unknown.msg, /brand_new_type/);
  assert.equal(mapEventToLog(null), null);
  assert.equal(mapEventToLog('nope'), null);
  assert.ok(mapEventToLog({ id: 1, type: 'state_transition' }));   // no details, no at
});

// ---------------------------------------------------------------------------
// Events → wire
// ---------------------------------------------------------------------------

test('wire: phases are exactly the documented mapping, all drawable by usePacketLayer', () => {
  assert.ok(KNOWN_PHASES.size >= 10, `parsed ${KNOWN_PHASES.size} phases`);
  const expected = {
    request_sent: 'sent', retry_sent: 'resent', request_processed: 'delivered',
    duplicate_suppressed: 'duplicate', request_dropped: 'dropped', response_dropped: 'dropped',
    request_rejected: 'failed', dialog_recovered: 'restored',
  };
  for (const e of events) {
    const w = mapEventToWire(e);
    if (w) assert.ok(KNOWN_PHASES.has(w.phase), `undrawable phase ${w.phase}`);
    if (e.type in expected) {
      assert.equal(w?.phase, expected[e.type], e.type);
      assert.equal(w.id, e.id);
      assert.equal(w.seq, e.seq ?? null);
    } else if (e.type === 'state_transition') {
      const to = e.details.to;
      assert.equal(w?.phase ?? null, to === 'COMMITTED' || to === 'RECOVERED' ? 'done' : to === 'FAILED' ? 'failed' : null);
    } else {
      assert.equal(w, null, `${e.type} should not animate`);
    }
  }
  assert.equal(mapEventToWire(null), null);
  assert.equal(mapEventToWire({ id: 1, type: 'brand_new_type' }), null);
});

// ---------------------------------------------------------------------------
// Cursor / epoch (§6)
// ---------------------------------------------------------------------------

test('events page: first page accepted; truncated first page restarts at the oldest event', () => {
  assert.deepEqual(resolveEventPage({ epoch: 'e1', truncated: false, oldest_available: 1 }, null), { reset: false, refetchFrom: null });
  assert.deepEqual(resolveEventPage({ epoch: 'e1', truncated: true, oldest_available: 41 }, null), { reset: false, refetchFrom: 40 });
});

test('events page: epoch change or truncation → reset local feed, refetch from the oldest retained', () => {
  assert.deepEqual(resolveEventPage({ epoch: 'e2', truncated: false, oldest_available: 96 }, 'e1'), { reset: true, refetchFrom: 95 });
  assert.deepEqual(resolveEventPage({ epoch: 'e1', truncated: true, oldest_available: 501 }, 'e1'), { reset: true, refetchFrom: 500 });
  assert.deepEqual(resolveEventPage({ epoch: 'e1', truncated: false, oldest_available: 1 }, 'e1'), { reset: false, refetchFrom: null });
});

test('appendCapped keeps the newest items and respects the cap', () => {
  const list = Array.from({ length: LOG_CAP }, (_, i) => i);
  const next = appendCapped(list, [LOG_CAP, LOG_CAP + 1], LOG_CAP);
  assert.equal(next.length, LOG_CAP);
  assert.equal(next[0], 2);
  assert.equal(next.at(-1), LOG_CAP + 1);
  assert.equal(appendCapped(list, [], LOG_CAP), list);
});

test('dirtyDialogIds collects dialog ids from events only', () => {
  const ids = dirtyDialogIds(events);
  for (const d of state.dialogs) assert.ok(ids.has(d.dialog_id), d.dialog_id);
  assert.ok(![...ids].includes(undefined));
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test('scenario result → scenarioResults entry and simulation', () => {
  const { result, simulation } = mapScenarioResult(s4);
  assert.equal(result.id, 4);
  assert.equal(result.status, 'passed');
  assert.equal(result.durationMs, s4.duration_ms);
  assert.equal(result.dialogId, s4.dialogs[0].dialog_id);
  assert.equal(result.assertions.length, s4.assertions.length);
  assert.ok(result.assertions.every((a) => a.ok === true && typeof a.label === 'string'));
  assert.equal(simulation.running, null);
  assert.equal(simulation.status, 'passed');
  assert.equal(simulation.steps.length, s4.steps.length);
  assert.ok(simulation.steps.every((s) => typeof s.at === 'number' && typeof s.text === 'string'));
  assert.deepEqual(Object.keys(idleSimulation()).sort(), Object.keys(simulation).sort());
});

test('GET /api/scenarios → results only for scenarios that ran', () => {
  const mapped = mapScenarioResults(scenarios);
  assert.deepEqual(Object.keys(mapped).sort(), ['1', '4']);
  assert.equal(mapped[1].runId, s1.run_id);
  assert.equal(mapped[4].status, 'passed');
});

test('live progress rebuilt from polled scenario_* events matches the final result', () => {
  const runId = scenarioRunIdFromEvents(events, 1);
  assert.equal(runId, s1.run_id);
  const progress = mapScenarioProgress(events, runId);
  assert.deepEqual(progress.steps.map((s) => s.text), s1.steps.map((s) => s.text));
  assert.deepEqual(progress.assertions.map((a) => [a.label, a.ok]), s1.assertions.map((a) => [a.label, a.ok]));
  assert.deepEqual(progress.finished, { status: 'passed', durationMs: s1.duration_ms });
  assert.equal(scenarioRunIdFromEvents(events, 3), null);
  assert.deepEqual(mapScenarioProgress(events, 'no-such-run'), { steps: [], assertions: [], finished: null });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('local notices get unique string ids that cannot collide with event ids', () => {
  const a = noticeLog('error', 'x');
  const b = noticeLog('error', 'y');
  assert.notEqual(a.id, b.id);
  assert.equal(typeof a.id, 'string');
  assert.equal(a.layer, 'control');
  assert.equal(a.meta.source, 'dashboard');
});

test('engine selection: backend by default under Vite, sim on request, sim outside Vite', () => {
  assert.equal(selectEngine({}), 'backend');
  assert.equal(selectEngine({ VITE_ENGINE: 'backend' }), 'backend');
  assert.equal(selectEngine({ VITE_ENGINE: 'sim' }), 'sim');
  assert.equal(selectEngine({ VITE_ENGINE: 'anything-else' }), 'backend');
  assert.equal(selectEngine(undefined), 'sim');
});

const failed = results.filter((r) => !r.ok);
const colour = failed.length === 0 ? GREEN : RED;
console.log(`\n${colour}${results.length - failed.length}/${results.length} checks passed${RESET}\n`);
if (failed.length) process.exitCode = 1;
