/**
 * Mapper tests (Phase 7a): backend API JSON → dashboard contract.
 *
 *   node tests/mappers.mjs
 *
 * Fixtures in tests/fixtures/ are REAL backend responses captured with
 * tests/capture-fixtures.mjs.  Plain node + node:assert.
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
  recoveryCounts,
  resolveEventPage,
  scenarioRunIdFromEvents,
} from '../src/api/mappers.js';
import { describeTask, narrate } from '../src/lib/narrate.js';
import { LAYERS, LIFECYCLE_STATES, LOG_KINDS, SCENARIOS, STATE_PLAIN, STATE_STYLE, TERMINAL_STATES, VALID_TRANSITIONS } from '../src/lib/constants.js';

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


/**
 * Frozen contract: the fields the components actually read (grep of
 * src/components + App.jsx, Phase 8).  If a component starts reading a new
 * field, add it here and to the mapper.
 */
const METRIC_FIELDS = ['activeDialogs', 'committed', 'dedup', 'durableDialogs', 'failed', 'inProgress', 'notStarted',
  'packets', 'recovered', 'recoveryAttempted', 'recoveryRate', 'recoverySucceeded', 'restoredOpen', 'sideEffects',
  'totalDialogs', 'uptimeMs'];
const VIEW_FIELDS = ['id', 'taskId', 'state', 'ledger', 'nextSeq', 'pendingSeqs', 'settled', 'sideEffects', 'suppressed'];
const LEDGER_ROW_FIELDS = ['seq', 'status', 'backendStatus'];
const LOG_FIELDS = ['id', 'origin', 'clock', 'kind', 'layer', 'msg', 'meta'];
const WIRE_FIELDS = ['id', 'phase', 'seq'];

/** Backend sources the UI must agree with (read as text; the backend is not imported). */
const backendTypes = await sourceOf('..', '..', 'backend', 'src', 'types', 'index.ts');
const backendScenarios = await sourceOf('..', '..', 'backend', 'src', 'scenarios', 'index.ts');

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

test('metrics: every field the components read exists in the mapped object', () => {
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

test('metrics: no placeholder fields from the removed browser simulation', () => {
  const mapped = mapMetrics(state.metrics, state.runtime);
  for (const f of ['buffered', 'pps', 'peakPps', 'walLsn', 'avgLatencyMs', 'suppressed']) assert.ok(!(f in mapped), `unexpected ${f}`);
  assert.deepEqual(mapMetrics(undefined), emptyMetrics());
  assert.equal(emptyMetrics().recoveryRate, null);   // MetricBar shows its "100%" empty state
});

test('metrics: recovery counts only restored tasks that have finished; open ones are separate', () => {
  const counts = recoveryCounts(state.metrics, state.dialogs);
  const restored = state.dialogs.filter((d) => d.restored);
  assert.equal(counts.attempted + counts.open, restored.length);
  assert.equal(counts.attempted, restored.filter((d) => d.terminal).length);
  assert.equal(counts.succeeded, restored.filter((d) => d.state === 'RECOVERED').length);
  assert.ok(counts.open >= 1, 'fixture has restored tasks still open');
  const mapped = mapState(state).metrics;
  assert.equal(mapped.recoveryAttempted, counts.attempted);
  assert.equal(mapped.recoverySucceeded, counts.succeeded);
  assert.equal(mapped.restoredOpen, counts.open);
  assert.equal(mapped.recoveryRate, counts.attempted ? (counts.succeeded / counts.attempted) * 100 : null);
  assert.equal(mapped.inProgress, state.metrics.by_state.PROCESSING);
  assert.equal(mapped.notStarted, state.metrics.by_state.INITIATED);
  const synthetic = recoveryCounts({}, [
    { restored: true, terminal: true, state: 'RECOVERED' },
    { restored: true, terminal: true, state: 'FAILED' },
    { restored: true, terminal: false, state: 'INITIATED' },
    { restored: false, terminal: true, state: 'COMMITTED' },
  ]);
  assert.deepEqual(synthetic, { attempted: 2, succeeded: 1, open: 1 });
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

test('dialog view: every field the components read exists, values from the summary/detail', () => {
  const view = mapDialogView(detail.dialog, detail);
  for (const f of VIEW_FIELDS) assert.ok(f in view, `missing ${f}`);
  for (const row of view.ledger) for (const f of LEDGER_ROW_FIELDS) assert.ok(f in row, `ledger row missing ${f}`);
  assert.equal(view.id, detail.dialog.dialog_id);
  assert.equal(view.taskId, 'task-fixture');
  assert.equal(view.state, 'PROCESSING');
  assert.equal(view.sideEffects, detail.dialog.processed_count);
  assert.equal(view.appliedCount, 2);
  assert.deepEqual(view.appliedOrder, [1, 2]);
  assert.equal(view.nextSeq, 4);
  assert.deepEqual(view.pendingSeqs, [2, 3]);
  assert.equal(view.settled, false);
  for (const f of ['buffered', 'missing', 'protocol', 'envelope', 'history', 'lastTx', 'restarts', 'terminalAt', 'latencyMs']) {
    assert.ok(!(f in view), `unexpected placeholder ${f}`);
  }
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
  assert.equal(r.headline, 'Unfinished task reloaded from the SQLite file');
  assert.match(r.detail, new RegExp(`gets packet ${recovered.details.next_seq}\\.`));

  const created = first('dialog_created');
  assert.equal(narrate(mapEventToLog(created)).headline, 'New task started');

  const commit = first('state_transition', (e) => e.details.to === 'COMMITTED');
  assert.equal(narrate(mapEventToLog(commit)).headline, 'Task is now: Completed');
  const fail = first('state_transition', (e) => e.details.to === 'FAILED');
  assert.equal(mapEventToLog(fail).kind, 'error');
});

test('logs: backend entries carry origin "backend"; UI notices "dashboard"', () => {
  for (const e of events) {
    const entry = mapEventToLog(e);
    if (entry) assert.equal(entry.origin, 'backend');
  }
  assert.equal(noticeLog('error', 'x').origin, 'dashboard');
});

test('logs: restarts are narrated as a full process restart, never "Sender Agent" only', () => {
  const restarts = events.filter((x) => x.type === 'adapter_restarted');
  assert.ok(restarts.length >= 2);
  for (const e of restarts) {
    const entry = mapEventToLog(e);
    assert.match(entry.msg, /scope process/);
    const spoken = narrate(entry);
    assert.doesNotMatch(spoken.headline, /Sender Agent/);
    if (e.details.phase === 'end') {
      assert.equal(spoken.headline, 'Backend process restarted — both agents reloaded from the saved database');
    } else {
      assert.equal(spoken.headline, `Restarting the whole backend process (Adapter ${e.details.target} was asked to restart)`);
      assert.match(spoken.detail, /share one database file/);
    }
  }
});

test('logs: backend narration for retry, replies, refusals, acks, reset, demos', () => {
  const retry = first('retry_sent');
  assert.equal(narrate(mapEventToLog(retry)).headline, `Retrying packet ${retry.seq} (attempt ${retry.details.attempts})`);

  const lostReply = first('response_dropped');
  const r = narrate(mapEventToLog(lostReply));
  assert.equal(r.headline, `Reply for packet ${lostReply.seq} was lost on the way back — the work WAS done`);
  assert.equal(r.tone, 'warn');

  const delivered = first('response_delivered', (e) => e.details.status === 'duplicate');
  assert.match(narrate(mapEventToLog(delivered)).detail, /stored the first time/);

  const refused = first('request_rejected');
  assert.equal(refused.details.error_code, 'DIALOG_TERMINAL');
  assert.equal(narrate(mapEventToLog(refused)).headline, `Packet ${refused.seq} refused — the task is already finished, so new work is refused`);
  assert.equal(narrate(mapEventToLog({ ...refused, details: { error_code: 'TASK_MISMATCH' } })).headline,
    `Packet ${refused.seq} refused — it names a different task than the one on record`);

  const acked = first('request_acked');
  assert.equal(narrate(mapEventToLog(acked)).headline, `Packet ${acked.seq} confirmed`);

  const lostReq = first('request_dropped');
  assert.equal(narrate(mapEventToLog(lostReq)).headline, `Packet ${lostReq.seq} was lost before reaching the Receiver Agent`);

  assert.equal(narrate(mapEventToLog(first('runtime_reset'))).headline, 'Demo data wiped — starting fresh');
  const started = first('scenario_started');
  assert.equal(narrate(mapEventToLog(started)).headline, `Demo ${started.details.scenario_id} started`);
  const finished = first('scenario_finished');
  assert.equal(narrate(mapEventToLog(finished)).headline, `Demo ${finished.details.scenario_id} passed`);
});

test('narration: every fixture event narrates without simulation-only wording', () => {
  const SIM_WORDS = /in order|out of order|held back|holding|gap|checkpoint|crashed|3 tries|confirmation|Waiting for/i;
  for (const e of events) {
    const entry = mapEventToLog(e);
    if (!entry) continue;
    for (const f of LOG_FIELDS) assert.ok(f in entry, `${e.type}: log entry missing ${f}`);
    const spoken = narrate(entry);
    assert.doesNotMatch(`${spoken.headline} ${spoken.detail ?? ''}`, SIM_WORDS, `${e.type}: ${spoken.headline}`);
    // Scenario step texts are shown verbatim, never re-interpreted by a message rule.
    if (e.type === 'scenario_step') assert.equal(spoken.headline, entry.msg, 'scenario steps are verbatim');
  }
  const recovered = first('dialog_recovered');
  const r = narrate(mapEventToLog(recovered));
  assert.equal(r.headline, 'Unfinished task reloaded from the SQLite file');
  assert.match(r.detail, new RegExp(`next new request gets packet ${recovered.details.next_seq}`));
  // dashboard notices never match an event rule
  assert.equal(narrate(noticeLog('success', 'manual restart A · whole backend process restarted')).headline, 'manual restart A · whole backend process restarted');
});

test('task line: one sentence per backend state, no simulation states', () => {
  const base = { sideEffects: 2, ledger: [], nextSeq: 3 };
  assert.equal(describeTask({ ...base, state: 'INITIATED' }), 'Created, waiting for the first request');
  assert.equal(describeTask({ ...base, state: 'PROCESSING' }), '2 work items completed so far');
  assert.equal(describeTask({ ...base, state: 'COMMITTED' }), 'All 2 work items completed, none repeated');
  assert.equal(describeTask({ ...base, state: 'RECOVERED' }), 'Finished after a restart — 2 work items, none repeated');
  assert.equal(describeTask({ ...base, state: 'FAILED' }), 'Stopped before finishing — the retry limit was reached or it was aborted');
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
  // usePacketLayer draws exactly the phases the mapper can produce (no simulation-only phases)
  assert.deepEqual([...KNOWN_PHASES].sort(), ['delivered', 'done', 'dropped', 'duplicate', 'failed', 'resent', 'restored', 'sent']);
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

test('lifecycle: exactly the five backend states and the backend transition table', () => {
  const states = /LIFECYCLE_STATES = \[([^\]]*)\]/.exec(backendTypes)[1].match(/'(\w+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(LIFECYCLE_STATES, states);
  assert.deepEqual(Object.keys(STATE_PLAIN), states);
  assert.deepEqual(Object.keys(STATE_STYLE), states);
  const table = backendTypes.slice(backendTypes.indexOf('VALID_TRANSITIONS'), backendTypes.indexOf('};', backendTypes.indexOf('VALID_TRANSITIONS')));
  for (const from of states) {
    const row = new RegExp(`${from}:\\s*\\[([^\\]]*)\\]`).exec(table)[1].match(/'(\w+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
    assert.deepEqual(VALID_TRANSITIONS[from], row, `transitions from ${from}`);
  }
  assert.deepEqual(TERMINAL_STATES, ['COMMITTED', 'RECOVERED', 'FAILED']);
});

test('scenario cards: five, titled exactly as the backend registry, no protocol tags', () => {
  const titles = [...backendScenarios.matchAll(/(\d):\s*\{\s*title:\s*'([^']+)'/g)].map((m) => [Number(m[1]), m[2]]);
  assert.equal(titles.length, 5);
  assert.deepEqual(SCENARIOS.map((c) => c.id), [1, 2, 3, 4, 5]);
  for (const [id, title] of titles) {
    const card = SCENARIOS.find((c) => c.id === id);
    assert.equal(`Scenario ${id} — ${card.title}`, title);
    assert.ok(!('protocol' in card), `card ${id} still has a protocol tag`);
    for (const f of ['tagline', 'description', 'outcome', 'watch']) assert.ok(card[f], `card ${id} missing ${f}`);
  }
});

test('wire: every mapped event carries the fields usePacketLayer reads', () => {
  for (const e of events) {
    const w = mapEventToWire(e);
    if (w) for (const f of WIRE_FIELDS) assert.ok(f in w, `${e.type}: wire missing ${f}`);
  }
});

const failed = results.filter((r) => !r.ok);
const colour = failed.length === 0 ? GREEN : RED;
console.log(`\n${colour}${results.length - failed.length}/${results.length} checks passed${RESET}\n`);
if (failed.length) process.exitCode = 1;
