/**
 * Pure mappers: backend API JSON → the objects the dashboard components read.
 * No React, no I/O.
 *
 * Honesty rules (docs/API_DESIGN.md §7, §11):
 *   - every number comes from a backend field; fields with no backend source
 *     are empty / zero / null, never invented;
 *   - log `msg` texts are built from the event, and are chosen so narrate.js
 *     either matches a rule whose wording is accurate for the event, or falls
 *     through to its default (which shows the message verbatim).
 */

import { clockStamp } from '../lib/format.js';

export const LOG_CAP = 600;
export const WIRE_CAP = 160;

const TERMINAL = new Set(['COMMITTED', 'RECOVERED', 'FAILED']);

const toMs = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.now();
};

// ---------------------------------------------------------------------------
// Metrics (DECISION 6 / §7)
// ---------------------------------------------------------------------------

export function emptyMetrics() {
  return {
    packets: 0,
    dedup: 0,
    sideEffects: 0,
    recoveryAttempted: 0,
    recoverySucceeded: 0,
    recoveryRate: null,
    activeDialogs: 0,
    totalDialogs: 0,
    committed: 0,
    recovered: 0,
    failed: 0,
    durableDialogs: 0,
    bootAt: null,
    uptimeMs: 0,
    inProgress: 0,
    notStarted: 0,
    restoredOpen: 0,
  };
}

/**
 * Recovery counted honestly (Phase 7b): a recovery is "attempted" once a
 * restored dialog has finished (any terminal state), "succeeded" if it finished
 * RECOVERED.  Restored dialogs that are still open are reported separately —
 * they have not failed.  Needs the dialog summaries; falls back to the durable
 * totals when they are not available.
 */
export function recoveryCounts(metrics, summaries) {
  const by = metrics?.by_state ?? {};
  if (!Array.isArray(summaries)) {
    return { attempted: metrics?.restored_total ?? 0, succeeded: by.RECOVERED ?? 0, open: 0 };
  }
  const restored = summaries.filter((d) => d.restored);
  const finished = restored.filter((d) => d.terminal ?? TERMINAL.has(d.state));
  return {
    attempted: finished.length,
    succeeded: finished.filter((d) => d.state === 'RECOVERED').length,
    open: restored.length - finished.length,
  };
}

/**
 * @param {object} metrics    state.metrics from GET /api/state
 * @param {object} runtime    state.runtime from GET /api/state
 * @param {object[]} [summaries] state.dialogs (for the recovery counts)
 */
export function mapMetrics(metrics, runtime, summaries) {
  if (!metrics) return emptyMetrics();
  const by = metrics.by_state ?? {};
  const recovery = recoveryCounts(metrics, summaries);
  const attempted = recovery.attempted;
  const succeeded = recovery.succeeded;
  return {
    ...emptyMetrics(),
    packets: metrics.transport_attempts ?? 0,          // durable: SUM(attempts)
    dedup: metrics.duplicates_since_boot ?? 0,          // since server start
    sideEffects: metrics.processed_count ?? 0,          // durable "work done"
    recoveryAttempted: attempted,                       // restored dialogs that have finished
    recoverySucceeded: succeeded,                       // of those, finished RECOVERED
    recoveryRate: attempted ? (succeeded / attempted) * 100 : null,
    restoredOpen: recovery.open,                        // restored dialogs still open (not failures)
    inProgress: by.PROCESSING ?? 0,
    notStarted: by.INITIATED ?? 0,
    activeDialogs: (by.INITIATED ?? 0) + (by.PROCESSING ?? 0),
    totalDialogs: metrics.dialogs_total ?? 0,
    committed: by.COMMITTED ?? 0,
    recovered: by.RECOVERED ?? 0,
    failed: by.FAILED ?? 0,
    durableDialogs: metrics.dialogs_total ?? 0,
    bootAt: runtime?.booted_at ? toMs(runtime.booted_at) : null,
    uptimeMs: runtime?.uptime_ms ?? metrics.uptime_ms ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Nodes (DECISION 7)
// ---------------------------------------------------------------------------

const node = (status) => ({ status, queue: 0, rtt: 0, writes: 0, uptimeMs: 0 });

export const OFFLINE_NODES = Object.freeze({
  adapterA: node('offline'),
  adapterB: node('offline'),
  storage: node('offline'),
  bridge: node('offline'),
});

/** Backend 'online' | 'restarting' → dashboard 'online' | 'booting'. */
const nodeStatus = (s) => (s === 'restarting' ? 'booting' : s === 'online' ? 'online' : 'offline');

export function mapNodes(nodes) {
  if (!nodes) return { ...OFFLINE_NODES };
  return {
    adapterA: node(nodeStatus(nodes.adapterA?.status)),
    adapterB: node(nodeStatus(nodes.adapterB?.status)),
    storage: node(nodeStatus(nodes.storage?.status)),
    bridge: node(nodeStatus(nodes.transport?.status)),
  };
}

// ---------------------------------------------------------------------------
// Dialogs, ledgers
// ---------------------------------------------------------------------------

/**
 * Backend ledger status → TaskList PacketStrip status.
 *   acked               → 'applied'  (processed, answer received)
 *   processed_unacked   → 'applied'  (B processed it; only the answer was lost)
 *   pending_unprocessed → 'missing'  (sent, never processed by B)
 */
export function mapLedgerStatus(status) {
  if (status === 'acked' || status === 'processed_unacked') return 'applied';
  if (status === 'pending_unprocessed') return 'missing';
  return 'pending';
}

export function mapLedger(detail) {
  if (!detail || !Array.isArray(detail.ledger)) return [];
  const processedAt = new Map((detail.processed ?? []).map((p) => [p.seq, p.processed_at]));
  return detail.ledger.map((row) => ({
    seq: row.seq,
    status: mapLedgerStatus(row.status),
    attempts: row.attempts ?? 0,
    at: processedAt.has(row.seq) ? toMs(processedAt.get(row.seq)) : null,
    backendStatus: row.status,
  }));
}

/** dialog ids are generated as dlg-<Date.now()>-<suffix>: the creation time is real data. */
export function createdAtFromId(dialogId) {
  const m = /^dlg-(\d{10,})-/.exec(String(dialogId ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * One dialog as TaskList / ManualControls read it.  `detail` (E4) is
 * optional: without it the ledger is empty.
 */
export function mapDialogView(summary, detail) {
  const processed = Array.isArray(detail?.processed) ? detail.processed : [];
  const appliedOrder = [...processed]
    .sort((a, b) => toMs(a.processed_at) - toMs(b.processed_at) || a.seq - b.seq)
    .map((p) => p.seq);
  return {
    id: summary.dialog_id,
    taskId: summary.task_id,
    state: summary.state,
    ledger: mapLedger(detail),
    appliedOrder,
    appliedCount: summary.processed_count ?? 0,
    nextSeq: summary.next_seq ?? 1,
    pendingSeqs: summary.pending_seqs ?? [],
    sideEffects: summary.processed_count ?? 0,       // durable work done
    sideEffectsSinceBoot: summary.side_effects_since_boot ?? 0,
    suppressed: summary.duplicates_since_boot ?? 0,  // in memory, since server start
    restored: Boolean(summary.restored),
    createdAt: createdAtFromId(summary.dialog_id),
    settled: Boolean(summary.terminal ?? TERMINAL.has(summary.state)),
  };
}

/** GET /api/state + cached E4 details → dashboard slices. */
export function mapState(state, details = new Map()) {
  const summaries = Array.isArray(state?.dialogs) ? state.dialogs : [];
  return {
    dialogs: summaries.map((s) => mapDialogView(s, details.get(s.dialog_id))),
    metrics: mapMetrics(state?.metrics, state?.runtime, summaries),
    nodes: mapNodes(state?.nodes),
    busy: Boolean(state?.runtime?.busy),
    runningScenario: state?.runtime?.running_scenario ?? null,
    epoch: state?.runtime?.epoch ?? null,
  };
}

// ---------------------------------------------------------------------------
// Events → activity log entries
// ---------------------------------------------------------------------------

const LAYER_BY_ACTOR = { A: 'adapter-a', B: 'adapter-b', transport: 'bridge', runtime: 'control', scenario: 'control' };

const STEP_KIND = { head: 'success', info: 'success', pass: 'success', warn: 'recovery', fail: 'error' };

/** [kind, msg, extraMeta] per event type, or null to omit from the feed. */
function describe(e) {
  const d = e.details ?? {};
  const seq = e.seq;
  switch (e.type) {
    case 'dialog_created':
      return ['success', `dialog opened · task_id ${e.task_id}`];
    case 'request_sent':
      return ['success', `dispatch seq ${seq} · request sent (attempt ${d.attempts ?? 1})`];
    case 'retry_sent':
      return ['recovery', `retry of seq ${seq} · attempt ${d.attempts ?? '?'}, same dialog_id, task_id, seq and stored payload`];
    case 'request_dropped':
      return ['error', `seq ${seq} request dropped in transit (simulated fault: drop_request)`];
    case 'request_processed':
      return ['success', `seq ${seq} applied by Adapter B → processed_count ${d.processed_count ?? '?'}`,
        { side_effects: d.processed_count }];
    case 'duplicate_suppressed':
      return ['duplicate', `seq ${seq} duplicate · stored result returned, side effect not run again${d.terminal ? ' (dialog finished)' : ''}`];
    case 'request_rejected':
      return ['error', `seq ${seq} rejected by Adapter B · ${d.error_code ?? 'INTERNAL'}`];
    case 'response_delivered':
      return ['success', `seq ${seq} response delivered to Adapter A (status ${d.status ?? e.outcome})`];
    case 'response_dropped':
      return ['error', `seq ${seq} response lost after Adapter B processed it (simulated fault: drop_response, B status ${d.b_status ?? '?'})`];
    case 'request_acked':
      return ['success', `seq ${seq} acknowledged · Adapter A send log ACKED`];
    case 'state_transition': {
      const kind = d.to === 'FAILED' ? 'error' : d.to === 'RECOVERED' ? 'recovery' : 'success';
      return [kind, `state ${d.from} → ${d.to} · ${d.reason ?? ''}`.trim()];
    }
    case 'dialog_recovered':
      return ['recovery', `dialog reloaded from the SQLite file · state ${d.state}, next_seq=${d.next_seq}, pending=[${(d.pending_seqs ?? []).join(', ')}]`,
        { next_sequence: d.next_seq }];
    case 'adapter_restarted':
      return d.phase === 'end'
        ? ['success', `process restart complete (target ${d.target}, scope ${d.scope ?? 'process'}) · both adapters rebuilt from the SQLite file`]
        : ['recovery', `process restart requested (target ${d.target}, scope ${d.scope ?? 'process'}) · shared store: both adapter objects are rebuilt from the SQLite file`];
    case 'scenario_started':
      return ['success', `demo ${d.scenario_id} started · ${d.title ?? ''}${d.variant ? ` (${d.variant})` : ''}`];
    case 'scenario_step':
      return [STEP_KIND[d.tone] ?? 'success', String(d.text ?? '')];
    case 'scenario_assertion':
      return null;   // the runner also emits a PASS/FAIL scenario_step for each check
    case 'scenario_finished':
      return [d.status === 'passed' ? 'success' : 'error',
        `demo ${d.scenario_id} ${d.status}${d.duration_ms !== undefined ? ` in ${d.duration_ms}ms` : ''}${d.error ? ` · ${d.error}` : ''}`];
    case 'runtime_reset':
      return ['success', `runtime reset · new epoch ${d.epoch ?? ''}`.trim()];
    default:
      return ['success', `${e.type ?? 'event'}${e.dialog_id ? ` · ${e.dialog_id}` : ''}`];
  }
}

/** One backend event → one activity-feed entry (null for types not shown). */
export function mapEventToLog(event) {
  if (!event || typeof event !== 'object') return null;
  const described = describe(event);
  if (!described) return null;
  const [kind, msg, extraMeta] = described;
  const at = toMs(event.at);
  const layer = event.type === 'dialog_recovered' ? 'sqlite' : LAYER_BY_ACTOR[event.actor] ?? 'control';
  const details = event.details && typeof event.details === 'object' ? event.details : {};
  return {
    id: event.id,
    origin: 'backend',          // narrate.js backend-only rules key on this
    at,
    ts: new Date(at).toISOString(),
    clock: clockStamp(at),
    kind,
    layer,
    dialogId: event.dialog_id ?? '-',
    msg,
    meta: {
      event_type: event.type,
      actor: event.actor,
      ...(event.task_id !== undefined ? { task_id: event.task_id } : {}),
      ...(event.seq !== undefined ? { sequence_no: event.seq } : {}),
      ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
      ...details,
      ...(extraMeta ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Events → wire (pipeline animation)
// ---------------------------------------------------------------------------

function wirePhase(e) {
  switch (e.type) {
    case 'request_sent': return 'sent';
    case 'retry_sent': return 'resent';
    case 'request_processed': return 'delivered';
    case 'duplicate_suppressed': return 'duplicate';
    case 'request_dropped':
    case 'response_dropped': return 'dropped';
    case 'request_rejected': return 'failed';
    case 'dialog_recovered': return 'restored';
    case 'state_transition': {
      const to = e.details?.to;
      if (to === 'COMMITTED' || to === 'RECOVERED') return 'done';
      if (to === 'FAILED') return 'failed';
      return null;
    }
    default: return null;
  }
}

/** One backend event → one wire event, or null when it has no animation. */
export function mapEventToWire(event) {
  if (!event || typeof event !== 'object') return null;
  const phase = wirePhase(event);
  if (!phase) return null;
  return {
    id: event.id,
    at: toMs(event.at),
    phase,
    dialogId: event.dialog_id ?? '-',
    seq: event.seq ?? null,
    attempt: event.details?.attempts ?? 1,
    restored: event.type === 'dialog_recovered',
    ...(event.type === 'request_dropped' ? { cause: 'request lost (simulated)' } : {}),
    ...(event.type === 'response_dropped' ? { cause: 'response lost (simulated)' } : {}),
  };
}

/** Dialog ids touched by a batch of events (their ledgers need a refetch). */
export function dirtyDialogIds(events) {
  const ids = new Set();
  for (const e of events ?? []) if (e?.dialog_id) ids.add(e.dialog_id);
  return ids;
}

/** Append and keep only the newest `cap` items. */
export function appendCapped(list, items, cap) {
  if (!items.length) return list;
  const next = list.concat(items);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

// ---------------------------------------------------------------------------
// Cursor / epoch handling (§6)
// ---------------------------------------------------------------------------

/**
 * Decide what to do with an events page.
 *   - first page ever (knownEpoch null): accept; if truncated, restart from the
 *     oldest retained event;
 *   - epoch changed (reset) or truncated (events evicted): drop local feed and
 *     restart from the oldest retained event (cursor = oldest_available - 1).
 *     Restarting from 0 would be truncated again forever.
 *
 * @returns {{ reset: boolean, refetchFrom: number|null }}
 *          refetchFrom = cursor to fetch again from, or null to use this page.
 */
export function resolveEventPage(page, knownEpoch) {
  const epochChanged = knownEpoch !== null && knownEpoch !== undefined && page.epoch !== knownEpoch;
  if (epochChanged || page.truncated) {
    return { reset: epochChanged || knownEpoch !== null, refetchFrom: Math.max(0, (page.oldest_available ?? 1) - 1) };
  }
  return { reset: false, refetchFrom: null };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export function idleSimulation() {
  return { running: null, dialogId: null, steps: [], assertions: [], startedAt: null, durationMs: null, status: 'idle' };
}

/** ScenarioResult (§8) → { result: scenarioResults entry, simulation } */
export function mapScenarioResult(r) {
  const steps = (r.steps ?? []).map((s) => ({ at: toMs(s.at), text: s.text, tone: s.tone }));
  const at = toMs(r.started_at) + (r.duration_ms ?? 0);
  const assertions = (r.assertions ?? []).map((a) => ({ label: a.label, ok: Boolean(a.ok), detail: a.detail ?? '', at }));
  const dialogId = r.dialogs?.[0]?.dialog_id ?? null;
  return {
    result: {
      id: r.scenario_id,
      status: r.status,
      durationMs: r.duration_ms ?? null,
      assertions,
      dialogId,
      dialogs: r.dialogs ?? [],
      runId: r.run_id,
      at,
      ...(r.error ? { error: r.error } : {}),
    },
    simulation: {
      running: null,
      dialogId,
      steps,
      assertions,
      startedAt: toMs(r.started_at),
      durationMs: r.duration_ms ?? null,
      status: r.status,
    },
  };
}

/** GET /api/scenarios → { [id]: scenarioResults entry } for scenarios that have run. */
export function mapScenarioResults(list) {
  const out = {};
  for (const s of list?.scenarios ?? []) {
    if (s.last_result) out[s.id] = mapScenarioResult(s.last_result).result;
  }
  return out;
}

/** run_id of the most recent scenario_started for `scenarioId` in a batch, or null. */
export function scenarioRunIdFromEvents(events, scenarioId) {
  let runId = null;
  for (const e of events ?? []) {
    if (e?.type === 'scenario_started' && e.details?.scenario_id === scenarioId) runId = e.details.run_id ?? runId;
  }
  return runId;
}

/** Steps / assertions / finish of one run, built from polled scenario_* events. */
export function mapScenarioProgress(events, runId) {
  const steps = [];
  const assertions = [];
  let finished = null;
  for (const e of events ?? []) {
    const d = e?.details;
    if (!d || d.run_id !== runId) continue;
    if (e.type === 'scenario_step') steps.push({ at: toMs(e.at), text: d.text, tone: d.tone });
    else if (e.type === 'scenario_assertion') assertions.push({ label: d.label, ok: Boolean(d.ok), detail: d.detail ?? '', at: toMs(e.at) });
    else if (e.type === 'scenario_finished') finished = { status: d.status, durationMs: d.duration_ms ?? null };
  }
  return { steps, assertions, finished };
}

// ---------------------------------------------------------------------------
// Local (UI-only) notices
// ---------------------------------------------------------------------------

let localSeq = 0;

/** A feed entry produced by the UI itself (e.g. 409 RUNTIME_BUSY), never by the backend. */
export function noticeLog(kind, msg, meta = {}) {
  const at = Date.now();
  localSeq += 1;
  return {
    id: `ui-${localSeq}`,
    origin: 'dashboard',
    at,
    ts: new Date(at).toISOString(),
    clock: clockStamp(at),
    kind,
    layer: 'control',
    dialogId: '-',
    msg,
    meta: { source: 'dashboard', ...meta },
  };
}
