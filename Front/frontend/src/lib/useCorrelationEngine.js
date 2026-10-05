import { useEffect, useRef, useState } from 'react';
import { PROTOCOL_MAP, SCENARIOS, TIMING, canTransition, isTerminal } from './constants.js';
import { buildEnvelope, correlationKey, deriveTaskId, payloadDigest } from './protocol.js';
import { clockStamp, isoStamp } from './format.js';

const LOG_CAPACITY = 600;
const WIRE_CAPACITY = 160;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomId = (len = 4) =>
  Array.from({ length: len }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('');

function createStore() {
  return {
    nodes: {
      adapterA: { status: 'online', queue: 0, rtt: 11, writes: 0, uptimeMs: 0 },
      adapterB: { status: 'online', queue: 0, rtt: 19, writes: 0, uptimeMs: 0 },
      storage: { status: 'online', queue: 0, rtt: 3, writes: 0, uptimeMs: 0 },
      bridge: { status: 'online', queue: 0, rtt: 24, writes: 0, uptimeMs: 0 },
    },
    dialogs: new Map(),
    durable: new Map(),
    blackhole: new Map(),
    logs: [],
    logSeq: 0,
    wire: [],
    wireSeq: 0,
    txSeq: 0,
    walLsn: 0,
    packets: 0,
    dedup: 0,
    suppressed: 0,
    sideEffects: 0,
    recoveryAttempted: 0,
    recoverySucceeded: 0,
    throughput: [],
    lastSamplePackets: 0,
    pps: 0,
    blocked: false,
    startedAt: Date.now(),
  };
}

function createDialog(dialogId, protocol) {
  const now = Date.now();
  return {
    id: dialogId,
    taskId: deriveTaskId(dialogId),
    protocol,
    state: 'INITIATED',
    history: [{ state: 'INITIATED', at: now, from: null, reason: 'dialog created by Adapter A', tx: null }],
    nextSeq: 1,
    seen: {},
    buffer: {},
    appliedOrder: [],
    outstanding: {},
    sideEffects: 0,
    suppressed: 0,
    restored: false,
    restarts: 0,
    pendingRecovery: false,
    createdAt: now,
    terminalAt: null,
    latencyMs: null,
    lastTx: null,
    lastEnvelope: null,
    t1: null,
    t2: null,
    gapTimer: null,
  };
}

/** Per-sequence ledger powering the lifecycle visualizer. */
function buildLedger(dialog) {
  const buffered = Object.keys(dialog.buffer)
    .map(Number)
    .sort((a, b) => a - b);
  const applied = Object.keys(dialog.seen)
    .map(Number)
    .sort((a, b) => a - b);
  const high = Math.max(dialog.nextSeq - 1, ...applied, ...buffered, 0);
  const rows = [];
  for (let seq = 1; seq <= Math.max(high, dialog.nextSeq); seq += 1) {
    const hit = dialog.seen[seq];
    const queued = dialog.buffer[seq];
    const status = hit ? 'applied' : queued ? 'buffered' : seq < high ? 'missing' : 'pending';
    rows.push({ seq, status, attempts: queued?.attempts ?? 0, tx: hit?.tx ?? null, at: hit?.at ?? null });
  }
  return rows;
}

function toView(dialog) {
  const ledger = buildLedger(dialog);
  const buffered = ledger.filter((row) => row.status === 'buffered');
  const missing = ledger.filter((row) => row.status === 'missing');
  return {
    id: dialog.id,
    taskId: dialog.taskId,
    protocol: dialog.protocol,
    state: dialog.state,
    history: dialog.history,
    ledger,
    appliedOrder: dialog.appliedOrder,
    appliedCount: Object.keys(dialog.seen).length,
    nextSeq: dialog.nextSeq,
    buffered: buffered.map((row) => row.seq),
    missing: missing.map((row) => row.seq),
    sideEffects: dialog.sideEffects,
    suppressed: dialog.suppressed,
    restored: dialog.restored,
    restarts: dialog.restarts,
    createdAt: dialog.createdAt,
    terminalAt: dialog.terminalAt,
    latencyMs: dialog.latencyMs ?? Date.now() - dialog.createdAt,
    settled: isTerminal(dialog.state),
    lastTx: dialog.lastTx,
    envelope: dialog.lastEnvelope,
  };
}

/**
 * Dialog correlation engine.
 *
 * Models the full PS-021 pipeline: framed dispatch over an unreliable 6G slice,
 * a reorder buffer, an idempotency ledger keyed on (dialog_id, sequence_no),
 * NACK-driven gap healing, and crash recovery from a durable SQLite snapshot.
 */
export function useCorrelationEngine() {
  const store = useRef(null);
  if (store.current === null) store.current = createStore();

  const timers = useRef(new Set());
  const flushQueued = useRef(false);
  const simRef = useRef({ running: null, dialogId: null, steps: [], assertions: [], startedAt: null, durationMs: null });

  const [logs, setLogs] = useState([]);
  const [wireEvents, setWire] = useState([]);
  const [dialogs, setDialogs] = useState([]);
  const [nodes, setNodes] = useState(() => store.current.nodes);
  const [metrics, setMetrics] = useState(() => computeMetrics(store.current, []));
  const [throughput, setThroughput] = useState([]);
  const [simulation, setSimulation] = useState({
    running: null,
    dialogId: null,
    steps: [],
    assertions: [],
    startedAt: null,
    durationMs: null,
    status: 'idle',
  });
  const [scenarioResults, setScenarioResults] = useState({});

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
    return id;
  }

  function clearLater(id) {
    if (!id) return;
    clearTimeout(id);
    timers.current.delete(id);
  }

  function nextTx() {
    store.current.txSeq += 1;
    return `tx-${store.current.txSeq.toString(16).padStart(6, '0')}`;
  }

  /**
   * Records a single hop on the wire.
   *
   * This is a presentation feed, deliberately kept separate from the audit log:
   * it says *where a packet is right now* (flying, held, lost, restored) rather
   * than proving what happened. The pipeline visualizer animates from this and
   * nothing else, so the animation can never disagree with the engine.
   *
   * Phases: sent, resent, delivered, sorted, held, duplicate, dropped,
   *         partition, restored, failed, done
   */
  function recordWire(phase, packet, extra = {}) {
    const s = store.current;
    const event = {
      id: (s.wireSeq += 1),
      at: Date.now(),
      phase,
      dialogId: packet?.dialogId ?? extra.dialogId ?? '-',
      seq: packet?.seq ?? extra.seq ?? null,
      attempt: packet?.attempt ?? extra.attempt ?? 1,
      restored: false,
      ...extra,
    };
    s.wire.push(event);
    if (s.wire.length > WIRE_CAPACITY) {
      s.wire.splice(0, s.wire.length - WIRE_CAPACITY);
    }
    return event;
  }

  function writeLog(kind, layer, dialogId, msg, meta = {}) {
    const at = Date.now();
    const entry = {
      id: (store.current.logSeq += 1),
      at,
      ts: isoStamp(at),
      clock: clockStamp(at),
      tx: nextTx(),
      kind,
      layer,
      dialogId: dialogId ?? '-',
      msg,
      meta,
    };
    store.current.logs.push(entry);
    if (store.current.logs.length > LOG_CAPACITY) {
      store.current.logs.splice(0, store.current.logs.length - LOG_CAPACITY);
    }
    scheduleFlush();
    return entry;
  }

  function scheduleFlush() {
    if (flushQueued.current) return;
    flushQueued.current = true;
    queueMicrotask(() => {
      flushQueued.current = false;
      publish();
    });
  }

  function publish() {
    const s = store.current;
    setLogs(s.logs.slice());
    setWire(s.wire.slice());
    setDialogs([...s.dialogs.values()].map(toView).sort((a, b) => b.createdAt - a.createdAt));
    setNodes({ ...s.nodes });
    setThroughput(s.throughput.slice());
    setMetrics(computeMetrics(s, s.throughput));
  }

  function computeMetrics(s, series) {
    const views = [...s.dialogs.values()];
    const latencies = views.map((d) => d.latencyMs).filter((value) => typeof value === 'number');
    return {
      packets: s.packets,
      dedup: s.dedup,
      suppressed: s.suppressed,
      sideEffects: s.sideEffects,
      recoveryAttempted: s.recoveryAttempted,
      recoverySucceeded: s.recoverySucceeded,
      recoveryRate: s.recoveryAttempted ? (s.recoverySucceeded / s.recoveryAttempted) * 100 : null,
      activeDialogs: views.filter((d) => !isTerminal(d.state)).length,
      totalDialogs: s.durable.size,
      committed: views.filter((d) => d.state === 'COMMITTED').length,
      recovered: views.filter((d) => d.state === 'RECOVERED').length,
      failed: views.filter((d) => d.state === 'FAILED').length,
      buffered: views.reduce((sum, d) => sum + Object.keys(d.buffer).length, 0),
      avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      pps: s.pps,
      peakPps: series.length ? Math.max(...series) : 0,
      walLsn: s.walLsn,
      durableDialogs: s.durable.size,
      bootAt: s.startedAt,
      // Calculated here rather than in the view so that rendering stays pure and
      // the figure always agrees with the telemetry tick that produced it.
      uptimeMs: Math.max(0, Date.now() - s.startedAt),
    };
  }

  function setNode(key, status) {
    store.current.nodes[key].status = status;
  }

  function ensureDialog(dialogId, protocol) {
    let dialog = store.current.dialogs.get(dialogId);
    if (!dialog) {
      dialog = createDialog(dialogId, protocol ?? 'MCP');
      store.current.dialogs.set(dialogId, dialog);
      writeLog('success', 'adapter-a', dialogId, `dialog opened · task_id ${dialog.taskId}`, {
        task_id: dialog.taskId,
        protocol: dialog.protocol,
        correlation_key: correlationKey(dialogId, 1),
      });
    } else if (protocol && dialog.protocol !== protocol) {
      dialog.protocol = protocol;
    }
    return dialog;
  }

  function persist(dialog) {
    store.current.walLsn += 1;
    store.current.nodes.storage.writes += 1;
    store.current.durable.set(dialog.id, {
      dialog_id: dialog.id,
      task_id: dialog.taskId,
      protocol: dialog.protocol,
      state: dialog.state,
      next_sequence: dialog.nextSeq,
      applied: { ...dialog.seen },
      buffered: Object.keys(dialog.buffer).map(Number).sort((a, b) => a - b),
      side_effects: dialog.sideEffects,
      suppressed: dialog.suppressed,
      applied_order: [...dialog.appliedOrder],
      history: dialog.history.map((entry) => ({ ...entry })),
      created_at: isoStamp(dialog.createdAt),
      persisted_at: isoStamp(),
      wal_lsn: store.current.walLsn,
      terminal: isTerminal(dialog.state),
    });
  }

  function clearDialogTimers(dialog) {
    clearLater(dialog.t1);
    clearLater(dialog.t2);
    clearLater(dialog.gapTimer);
    dialog.t1 = null;
    dialog.t2 = null;
    dialog.gapTimer = null;
  }

  function transition(dialog, next, reason, meta = {}) {
    if (dialog.state === next) return false;
    if (!canTransition(dialog.state, next)) {
      writeLog('error', 'control', dialog.id, `illegal transition ${dialog.state} → ${next} rejected by state machine`, {
        from: dialog.state,
        to: next,
        allowed: [],
        ...meta,
      });
      return false;
    }
    const from = dialog.state;
    dialog.state = next;
    const at = Date.now();
    dialog.history.push({ state: next, at, from, reason, tx: nextTx() });

    const terminal = isTerminal(next);
    if (terminal) {
      dialog.terminalAt = at;
      dialog.latencyMs = at - dialog.createdAt;
      if (dialog.pendingRecovery) {
        store.current.recoverySucceeded += 1;
        dialog.pendingRecovery = false;
      }
      dialog.outstanding = {};
      clearDialogTimers(dialog);
      recordWire(next === 'FAILED' ? 'failed' : 'done', null, {
        dialogId: dialog.id,
        seq: dialog.nextSeq - 1,
        restored: dialog.restored,
      });
    }

    writeLog(
      next === 'RECOVERED' ? 'recovery' : 'success',
      'adapter-a',
      dialog.id,
      `state ${from} → ${next} · ${reason}`,
      {
        from,
        to: next,
        reason,
        task_id: dialog.taskId,
        protocol: dialog.protocol,
        side_effects: dialog.sideEffects,
        suppressed: dialog.suppressed,
        latency_ms: dialog.latencyMs,
        restarts: dialog.restarts,
      },
    );
    writeLog('success', 'sqlite', dialog.id, `WAL checkpoint @ lsn ${store.current.walLsn} · ${next} persisted`, {
      task_id: dialog.taskId,
      wal_lsn: store.current.walLsn,
      next_sequence: dialog.nextSeq,
      durability: terminal ? 'fsync' : 'append',
    });
    persist(dialog);
    return true;
  }

  function ackOutstanding(dialog, seq) {
    delete dialog.outstanding[seq];
  }

  function makePacket({ dialogId, seq, protocol, payload, tx, attempt = 1, source, retransmitted = false }) {
    const taskId = deriveTaskId(dialogId);
    return {
      dialogId,
      seq,
      protocol,
      payload,
      tx,
      attempt,
      source,
      retransmitted,
      taskId,
      digest: payloadDigest(payload),
      envelope: buildEnvelope(protocol, {
        dialogId,
        sequenceNo: seq,
        payload,
        txId: tx,
        attempt,
        taskId,
        state: 'working',
      }),
    };
  }

  /**
   * Core ingress path for a single frame. Mirrors what the bridge hands to
   * Adapter A: dedup, reorder buffering, apply, drain, checkpoint, settle.
   */
  function transmit(packet, { source = 'bridge' } = {}) {
    const s = store.current;
    s.packets += 1;
    if (packet.retransmitted) recordWire('resent', packet);

    if (s.blackhole.get(packet.dialogId)?.has(packet.seq)) {
      recordWire('dropped', packet, { cause: 'lost in network' });
      writeLog('error', 'bridge', packet.dialogId, `seq ${packet.seq} blackholed by test harness`, {
        sequence_no: packet.seq,
        protocol: packet.protocol,
        task_id: packet.taskId,
        source,
        envelope: packet.envelope,
      });
      return { outcome: 'blackholed' };
    }

    if (s.blocked) {
      recordWire('dropped', packet, { cause: 'connection broken' });
      writeLog('error', 'bridge', packet.dialogId, `seq ${packet.seq} dropped in transit · slice partition active`, {
        sequence_no: packet.seq,
        protocol: packet.protocol,
        task_id: packet.taskId,
        source,
        rtt_ms: s.nodes.bridge.rtt,
        envelope: packet.envelope,
      });
      return { outcome: 'dropped' };
    }

    const dialog = ensureDialog(packet.dialogId, packet.protocol);
    dialog.lastTx = packet.tx;
    dialog.lastEnvelope = packet.envelope;

    const first = dialog.seen[packet.seq];
    const queued = dialog.buffer[packet.seq];
    if (first || queued) {
      s.dedup += 1;
      s.suppressed += 1;
      dialog.suppressed += 1;
      ackOutstanding(dialog, packet.seq);
      recordWire('duplicate', packet);
      writeLog('duplicate', 'adapter-a', dialog.id, `seq ${packet.seq} rejected · correlation key already satisfied`, {
        sequence_no: packet.seq,
        expected_sequence: dialog.nextSeq,
        task_id: dialog.taskId,
        protocol: dialog.protocol,
        correlation_key: correlationKey(dialog.id, packet.seq, first?.attempt ?? 1),
        original_tx: first?.tx ?? queued?.packet.tx,
        replay_tx: packet.tx,
        digest_match: first ? first.digest === packet.digest : null,
        side_effects: dialog.sideEffects,
        suppressed: dialog.suppressed,
        state: dialog.state,
        source,
        envelope: packet.envelope,
      });
      scheduleFlush();
      return { outcome: 'duplicate' };
    }

    if (packet.seq > dialog.nextSeq) {
      dialog.buffer[packet.seq] = { packet, attempts: 0, firstSeenAt: Date.now() };
      const gap = packet.seq - dialog.nextSeq;
      recordWire('held', packet, { waitingFor: dialog.nextSeq });
      writeLog('recovery', 'adapter-a', dialog.id, `seq ${packet.seq} buffered · expecting seq ${dialog.nextSeq} (gap of ${gap})`, {
        sequence_no: packet.seq,
        expected_sequence: dialog.nextSeq,
        gap,
        buffered: Object.keys(dialog.buffer).map(Number).sort((a, b) => a - b),
        task_id: dialog.taskId,
        protocol: dialog.protocol,
        state: dialog.state,
        source,
        envelope: packet.envelope,
      });
      scheduleGapScan(dialog);
      scheduleFlush();
      return { outcome: 'buffered' };
    }

    applyFrame(dialog, packet, source, false);
    drainBuffer(dialog, source);
    persist(dialog);
    armSettle(dialog);
    publish();
    return { outcome: 'applied' };
  }

  function applyFrame(dialog, packet, source, viaBuffer) {
    dialog.seen[packet.seq] = {
      tx: packet.tx,
      at: Date.now(),
      attempt: packet.attempt,
      digest: packet.digest,
      source,
    };
    dialog.appliedOrder.push(packet.seq);
    dialog.sideEffects += 1;
    store.current.sideEffects += 1;
    dialog.nextSeq = packet.seq + 1;
    ackOutstanding(dialog, packet.seq);

    // A frame released from the reorder buffer is the visual proof that
    // out-of-order delivery was put back in order, so it gets its own phase.
    recordWire(viaBuffer ? 'sorted' : 'delivered', packet, { waitingFor: null });

    if (dialog.state === 'INITIATED') {
      transition(dialog, 'PROCESSING', `first frame (seq ${packet.seq}) applied`, { sequence_no: packet.seq });
    } else if (dialog.state === 'WAITING_ACK') {
      transition(dialog, 'PROCESSING', `frame seq ${packet.seq} arrived inside the ack window`, {
        sequence_no: packet.seq,
      });
    }

    const annotations = [
      viaBuffer ? 'released from reorder buffer' : null,
      packet.retransmitted ? `re-transmission attempt ${packet.attempt}` : null,
    ].filter(Boolean);

    writeLog('success', 'adapter-a', dialog.id, `seq ${packet.seq} applied → side-effect ${dialog.sideEffects}`, {
      sequence_no: packet.seq,
      expected_sequence: dialog.nextSeq,
      task_id: dialog.taskId,
      protocol: dialog.protocol,
      side_effects: dialog.sideEffects,
      correlation_key: correlationKey(dialog.id, packet.seq, packet.attempt),
      digest: packet.digest,
      annotations,
      source,
      envelope: packet.envelope,
    });
  }

  function drainBuffer(dialog, source) {
    let released = 0;
    while (dialog.buffer[dialog.nextSeq]) {
      const { packet } = dialog.buffer[dialog.nextSeq];
      delete dialog.buffer[dialog.nextSeq];
      applyFrame(dialog, packet, source, true);
      released += 1;
    }
    return released;
  }

  /**
   * The window this dialog still cannot account for: every sequence below the
   * highest buffered frame that has neither been applied nor buffered. Returns
   * null when the reorder buffer implies no hole.
   *
   * Shared by the NACK scan and by the terminal-transition veto so that both
   * agree on exactly what "this dialog is still incomplete" means. Without a
   * single definition of the gap, a dialog could settle to COMMITTED while a
   * frame was still missing and the peer would believe work completed that was
   * never delivered.
   */
  function openWindow(dialog) {
    const buffered = Object.keys(dialog.buffer)
      .map(Number)
      .sort((a, b) => a - b);
    if (!buffered.length) return null;

    const high = buffered[buffered.length - 1];
    if (high < dialog.nextSeq) return null;

    const missing = [];
    for (let seq = dialog.nextSeq; seq < high; seq += 1) {
      if (!dialog.seen[seq] && !dialog.buffer[seq]) missing.push(seq);
    }

    return { buffered, high, missing };
  }

  /** Human-readable form of `openWindow` for the log line, or null when complete. */
  function describeOpenGap(dialog) {
    const window = openWindow(dialog);
    if (!window || !window.missing.length) return null;
    const { missing, buffered } = window;
    const span = missing.length > 1 ? `${missing[0]}, ${missing[missing.length - 1]}` : String(missing[0]);
    return `seq ${span} of ${missing.length} still unresolved while ${buffered.join(', ')} sit(s) buffered`;
  }

  function armSettle(dialog) {
    clearLater(dialog.t1);
    clearLater(dialog.t2);
    dialog.t1 = later(() => {
      dialog.t1 = null;
      if (isTerminal(dialog.state)) return;
      if (dialog.state !== 'WAITING_ACK') {
        transition(dialog, 'WAITING_ACK', `quiescence window elapsed (${TIMING.QUIET_MS}ms with no new frames)`);
      }
      dialog.t2 = later(() => {
        dialog.t2 = null;
        if (dialog.state !== 'WAITING_ACK') return;

        const openGap = describeOpenGap(dialog);
        if (openGap) {
          writeLog('recovery', 'adapter-a', dialog.id, `commit withheld · ${openGap}`, {
            sequence_no: dialog.nextSeq,
            expected_sequence: dialog.nextSeq,
            task_id: dialog.taskId,
            protocol: dialog.protocol,
            correlation_key: correlationKey(dialog.id, dialog.nextSeq, 0),
            annotations: ['ack window expired but the dialog is still incomplete'],
          });
          armSettle(dialog);
          return;
        }

        const target = dialog.restored ? 'RECOVERED' : 'COMMITTED';
        transition(
          dialog,
          target,
          dialog.restored
            ? 'rehydrated dialog fully acknowledged after restart'
            : 'every frame acknowledged by the peer adapter',
        );
        publish();
      }, TIMING.ACK_MS);
    }, TIMING.QUIET_MS);
  }

  function scheduleGapScan(dialog, delay = TIMING.NACK_INTERVAL) {
    clearLater(dialog.gapTimer);
    dialog.gapTimer = later(() => scanForGaps(dialog), delay);
  }

  /** Detects a hole below the highest buffered sequence and NACKs the window. */
  function scanForGaps(dialog) {
    dialog.gapTimer = null;
    if (isTerminal(dialog.state)) return;

    const gap = openWindow(dialog);
    if (!gap) return;
    const { buffered, high, missing } = gap;
    if (!missing.length) {
      scheduleGapScan(dialog);
      return;
    }

    const head = dialog.buffer[high];
    head.attempts += 1;
    if (head.attempts > TIMING.MAX_RETRANSMITS) {
      dialog.pendingRecovery = false;
      writeLog('error', 'adapter-a', dialog.id, `gap window [${missing.join(', ')}] unrecoverable after ${head.attempts - 1} re-transmission rounds`, {
        sequence_no: missing[0],
        expected_sequence: dialog.nextSeq,
        missing_window: missing,
        attempts: head.attempts - 1,
        task_id: dialog.taskId,
        side_effects: dialog.sideEffects,
      });
      transition(dialog, 'FAILED', `missing sequence ${missing[0]} never re-transmitted`, {
        missing_window: missing,
        attempts: head.attempts - 1,
      });
      publish();
      return;
    }

    store.current.recoveryAttempted += 1;
    dialog.pendingRecovery = true;
    recordWire('nack', null, { dialogId: dialog.id, seq: missing[0], attempts: head.attempts });
    writeLog('recovery', 'bridge', dialog.id, `NACK seq ${missing.join(', ')} · gap below buffered seq ${high}, requesting re-transmission (attempt ${head.attempts}/${TIMING.MAX_RETRANSMITS})`, {
      sequence_no: missing[0],
      expected_sequence: dialog.nextSeq,
      missing_window: missing,
      attempts: head.attempts,
      buffered_seq: high,
      task_id: dialog.taskId,
      protocol: dialog.protocol,
      buffered,
    });

    for (const seq of missing) {
      const retransmit = makePacket({
        dialogId: dialog.id,
        seq,
        protocol: dialog.protocol,
        payload: { ...head.packet.payload, __retransmitted: true, __original_seq: seq, __seed_seq: high },
        tx: nextTx(),
        attempt: head.attempts,
        source: 'nack-retransmit',
        retransmitted: true,
      });
      transmit(retransmit, { source: 'nack-retransmit' });
    }
    scheduleGapScan(dialog);
    publish();
  }

  /** Sender-side retransmission timer (TCP-style RTO) as a second safety net. */
  function watchdogTick() {
    const now = Date.now();
    let acted = false;
    for (const dialog of store.current.dialogs.values()) {
      if (isTerminal(dialog.state)) continue;
      for (const [seqKey, record] of Object.entries(dialog.outstanding)) {
        const seq = Number(seqKey);
        if (dialog.seen[seq] || dialog.buffer[seq]) {
          delete dialog.outstanding[seq];
          continue;
        }
        if (now - record.sentAt < TIMING.RTO) continue;
        if (record.attempts >= TIMING.MAX_RETRANSMITS) continue;
        record.attempts += 1;
        record.sentAt = now;
        store.current.recoveryAttempted += 1;
        dialog.pendingRecovery = true;
        writeLog('recovery', 'bridge', dialog.id, `RTO fired for seq ${seq} · sender re-transmitting (attempt ${record.attempts}/${TIMING.MAX_RETRANSMITS})`, {
          sequence_no: seq,
          expected_sequence: dialog.nextSeq,
          attempts: record.attempts,
          rto_ms: TIMING.RTO,
          task_id: dialog.taskId,
          correlation_key: correlationKey(dialog.id, seq, record.attempts),
        });
        const again = makePacket({
          dialogId: dialog.id,
          seq,
          protocol: dialog.protocol,
          payload: record.payload,
          tx: nextTx(),
          attempt: record.attempts,
          source: 'sender-rto',
          retransmitted: true,
        });
        transmit(again, { source: 'sender-rto' });
        acted = true;
      }
    }
    if (acted) publish();
  }

  function sendFrame({ dialogId, seq, protocol, payload, attempt = 1, source = 'dispatcher', retransmitted = false }) {
    const dialog = ensureDialog(dialogId, protocol);
    const tx = nextTx();
    const packet = makePacket({ dialogId, seq, protocol, payload, tx, attempt, source, retransmitted });
    const previous = dialog.outstanding[seq];
    dialog.outstanding[seq] = {
      sentAt: Date.now(),
      attempts: previous ? previous.attempts : 0,
      payload,
      tx,
    };
    recordWire(attempt > 1 || retransmitted ? 'resent' : 'sent', packet);
    return transmit(packet, { source });
  }

  function addBlackhole(dialogId, seq) {
    if (!store.current.blackhole.has(dialogId)) store.current.blackhole.set(dialogId, new Set());
    store.current.blackhole.get(dialogId).add(Number(seq));
  }

  function clearBlackholes(dialogId) {
    if (dialogId) store.current.blackhole.delete(dialogId);
    else store.current.blackhole.clear();
  }

  function partitionBridge(dialogId, seq) {
    store.current.blocked = true;
    setNode('bridge', 'degraded');
    setNode('adapterA', 'offline');
    recordWire('partition', null, { dialogId, seq });
    writeLog('error', 'bridge', dialogId, `6G slice partition established · seq ${seq} will be lost`, {
      sequence_no: seq,
      slice: 'urllc-egress-7',
      rtt_ms: null,
      retransmit_rto_ms: TIMING.RTO,
    });
    publish();
  }

  function killAdapter(dialogId) {
    const dialog = store.current.dialogs.get(dialogId);
    if (dialog) {
      persist(dialog);
      clearDialogTimers(dialog);
    }
    setNode('adapterA', 'offline');
    setNode('bridge', 'offline');
    writeLog('error', 'adapter-a', dialogId, 'SIGKILL · Adapter A terminated, volatile dialog RAM discarded', {
      pid: 4200 + Math.floor(Math.random() * 400),
      task_id: dialog?.taskId ?? null,
      persisted_snapshot: store.current.durable.has(dialogId),
      next_sequence: dialog?.nextSeq ?? null,
      side_effects: dialog?.sideEffects ?? 0,
      outstanding: dialog ? Object.keys(dialog.outstanding) : [],
      memory: 'wiped',
    });
    store.current.dialogs.delete(dialogId);
    publish();
  }

  async function coldStartAdapter() {
    setNode('adapterA', 'booting');
    setNode('bridge', 'booting');
    writeLog('success', 'control', null, 'process supervisor restarting Adapter A', { pid: 4800 + Math.floor(Math.random() * 400) });
    publish();
    await sleep(TIMING.QUIET_MS);

    let revived = 0;
    for (const snapshot of store.current.durable.values()) {
      if (snapshot.terminal) continue;
      if (store.current.dialogs.has(snapshot.dialog_id)) continue;
      const dialog = createDialog(snapshot.dialog_id, snapshot.protocol);
      dialog.taskId = snapshot.task_id;
      dialog.state = snapshot.state;
      dialog.history = [
        ...snapshot.history,
        {
          state: snapshot.state,
          at: Date.now(),
          from: snapshot.state,
          reason: 'rehydrated from durable snapshot',
          tx: nextTx(),
        },
      ];
      dialog.nextSeq = snapshot.next_sequence;
      dialog.seen = { ...snapshot.applied };
      dialog.appliedOrder = [...snapshot.applied_order];
      dialog.sideEffects = snapshot.side_effects;
      dialog.suppressed = snapshot.suppressed;
      dialog.createdAt = new Date(snapshot.created_at).getTime();
      dialog.restored = true;
      dialog.restarts = 1;
      for (const seq of snapshot.buffered) {
        dialog.buffer[seq] = {
          packet: makePacket({
            dialogId: snapshot.dialog_id,
            seq,
            protocol: snapshot.protocol,
            payload: { __restored_from: 'wal', __seq: seq },
            tx: nextTx(),
            attempt: 1,
            source: 'sqlite-rehydrate',
          }),
          attempts: 0,
          firstSeenAt: Date.now(),
        };
      }
      store.current.dialogs.set(dialog.id, dialog);
      revived += 1;
      store.current.recoveryAttempted += 1;
      dialog.pendingRecovery = true;
      recordWire('restored', null, { dialogId: dialog.id, seq: dialog.nextSeq - 1, restored: true });
      writeLog('recovery', 'sqlite', dialog.id, `durable snapshot rehydrated · next_seq=${dialog.nextSeq}, side_effects=${dialog.sideEffects}`, {
        task_id: dialog.taskId,
        wal_lsn: snapshot.wal_lsn,
        next_sequence: dialog.nextSeq,
        side_effects: dialog.sideEffects,
        restored_state: snapshot.state,
        buffered: snapshot.buffered,
      });
      if (!isTerminal(dialog.state)) armSettle(dialog);
    }

    store.current.blocked = false;
    setNode('adapterA', 'online');
    setNode('bridge', 'online');
    writeLog('success', 'control', null, `Adapter A online · ${revived} dialog(s) rehydrated, dedup ledger intact`, {
      rehydrated: revived,
      durable_dialogs: store.current.durable.size,
    });
    publish();
  }

  function viewOf(dialogId) {
    const dialog = store.current.dialogs.get(dialogId);
    return dialog ? toView(dialog) : null;
  }

  async function waitForTerminal(dialogId, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const dialog = store.current.dialogs.get(dialogId);
      if (dialog && isTerminal(dialog.state)) return true;
      await sleep(60);
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Payload studio bridge                                                */
  /* ------------------------------------------------------------------ */

  async function dispatch(form) {
    const { dialogId, seq, protocol, payload, delayMs = 0, outOfOrder = false, blackhole = false } = form;
    const target = Number(seq);
    ensureDialog(dialogId, protocol);

    if (blackhole) addBlackhole(dialogId, target);

    writeLog('success', 'control', dialogId, `dispatch seq ${target} · ${PROTOCOL_MAP[protocol].label}`, {
      sequence_no: target,
      protocol,
      protocol_label: PROTOCOL_MAP[protocol].label,
      envelope_spec: PROTOCOL_MAP[protocol].spec,
      out_of_order: outOfOrder,
      delay_ms: delayMs,
      blackholed: blackhole,
    });
    publish();

    if (delayMs > 0) {
      writeLog('recovery', 'bridge', dialogId, `holding seq ${target} for ${delayMs}ms · artificial link latency`, {
        sequence_no: target,
        delay_ms: delayMs,
      });
      await sleep(delayMs);
    }

    if (outOfOrder) {
      writeLog('recovery', 'bridge', dialogId, `shim reordering · seq ${target + 1} put on the wire ahead of seq ${target}`, {
        sequence_no: target + 1,
        expected_sequence: target,
      });
      sendFrame({
        dialogId,
        seq: target + 1,
        protocol,
        payload: { ...payload, __reorder_probe: true, __for_seq: target },
        source: 'dispatcher-reorder',
      });
      await sleep(Math.min(420, Math.max(200, delayMs)));
    }

    sendFrame({ dialogId, seq: target, protocol, payload, source: 'dispatcher' });
  }

  /* ------------------------------------------------------------------ */
  /* Scenario console                                                     */
  /* ------------------------------------------------------------------ */

  function say(text, tone = 'info') {
    simRef.current.steps.push({ at: Date.now(), text, tone });
    setSimulation({
      ...simRef.current,
      status: simRef.current.running ? 'running' : 'complete',
      assertions: simRef.current.assertions.slice(),
      steps: simRef.current.steps.slice(),
    });
  }

  function assert(label, ok, detail = '') {
    const row = { label, ok: Boolean(ok), detail, at: Date.now() };
    simRef.current.assertions.push(row);
    say(`${ok ? 'PASS' : 'FAIL'} · ${label}${detail ? ` — ${detail}` : ''}`, ok ? 'pass' : 'fail');
    return Boolean(ok);
  }

  const scenarioBody = {
    1: async ({ id, protocol, assert: check }) => {
      say(`A new task is created on the Sender Agent`, 'info');
      for (const seq of [1, 2, 3]) {
        sendFrame({ dialogId: id, seq, protocol, payload: { step: seq, op: 'advance_dialog' } });
        say(`Packet ${seq} crosses the network and its work is done once`, 'info');
        await sleep(220);
      }
      await waitForTerminal(id);
      const view = viewOf(id);
      check('All 3 work items completed', view?.sideEffects === 3, `work items=${view?.sideEffects}`);
      check('The task finished successfully', view?.state === 'COMMITTED', `status=${view?.state}`);
      check('Work happened in the correct order, 1 then 2 then 3', view?.appliedOrder.join(',') === '1,2,3', `order=${view?.appliedOrder.join(', ')}`);
    },

    2: async ({ id, protocol, assert: check }) => {
      say('The network will deliver the packets as 3, then 1, then 2', 'info');
      sendFrame({ dialogId: id, seq: 3, protocol, payload: { step: 3 } });
      say('Packet 3 arrived first, so it is safely held back', 'info');
      await sleep(260);
      sendFrame({ dialogId: id, seq: 1, protocol, payload: { step: 1 } });
      say('Packet 1 is processed while packet 3 waits', 'info');
      await sleep(260);
      sendFrame({ dialogId: id, seq: 2, protocol, payload: { step: 2 } });
      say('Packet 2 arrives, so packet 3 is released and everything is now in order', 'info');
      await waitForTerminal(id, 5000);
      const view = viewOf(id);
      check('The held-back packet was released', view?.buffered.length === 0, `still holding=${view?.buffered.length}`);
      check('Work was done in the correct order, 1 then 2 then 3', view?.appliedOrder.join(',') === '1,2,3', `order=${view?.appliedOrder.join(', ')}`);
      check('All 3 work items completed', view?.sideEffects === 3, `work items=${view?.sideEffects}`);
      check('The task finished successfully', view?.state === 'COMMITTED', `status=${view?.state}`);
    },

    3: async ({ id, protocol, assert: check }) => {
      sendFrame({ dialogId: id, seq: 1, protocol, payload: { step: 1 } });
      sendFrame({ dialogId: id, seq: 2, protocol, payload: { step: 2 } });
      await sleep(280);
      const before = viewOf(id);
      say('Packets 1 and 2 are done, and the task is saved in the database', 'info');
      check('The task was saved in the database before the fault', store.current.durable.has(id), `checkpoints=${store.current.walLsn}`);

      partitionBridge(id, 3);
      sendFrame({ dialogId: id, seq: 3, protocol, payload: { step: 3 } });
      say('Packet 3 is sent, but the connection breaks and it is lost', 'warn');
      await sleep(240);

      const taskId = before?.taskId;
      killAdapter(id);
      say('The Sender Agent crashes and loses everything in memory', 'warn');
      await sleep(360);
      check('Nothing about this task is left in memory', !store.current.dialogs.has(id), `tasks in memory=${store.current.dialogs.size}`);

      await coldStartAdapter();
      const revived = viewOf(id);
      say('The agent has restarted and reloaded the unfinished task from the database', 'info');
      check('The task is still recognised as the same task', revived?.taskId === taskId, `reference kept`);
      check('The 2 completed work items were restored, not repeated', revived?.sideEffects === 2, `work items=${revived?.sideEffects}`);
      check('The record of finished work survived the crash', revived?.appliedCount === 2, `remembered=${revived?.appliedCount}`);

      sendFrame({ dialogId: id, seq: 3, protocol, payload: { step: 3 }, attempt: 2, source: 'sender-retry' });
      say('Now that the connection is back, packet 3 is sent again', 'info');
      await waitForTerminal(id, 6000);
      const final = viewOf(id);
      check('The task was recovered rather than restarted', final?.state === 'RECOVERED', `status=${final?.state}`);
      check('All 3 work items completed with nothing repeated', final?.sideEffects === 3, `work items=${final?.sideEffects}`);
      check('Work was done in the correct order, 1 then 2 then 3', final?.appliedOrder.join(',') === '1,2,3', `order=${final?.appliedOrder.join(', ')}`);
    },

    4: async ({ id, protocol, assert: check }) => {
      const payload = { operation: 'upsert', collection: 'dialog_checkpoint', key: 'ue-042/stream-7', value: { phase: 'committed' } };
      sendFrame({ dialogId: id, seq: 1, protocol, payload });
      say('Packet 1 is processed and one work item is recorded', 'info');
      await sleep(220);
      const baseline = viewOf(id);
      check('One work item recorded', baseline?.sideEffects === 1, `work items=${baseline?.sideEffects}`);

      for (let replay = 1; replay <= 3; replay += 1) {
        sendFrame({ dialogId: id, seq: 1, protocol, payload, source: 'replay' });
        say(`Copy ${replay} of packet 1 arrives — it looks identical to the first`, 'warn');
        await sleep(190);
      }

      sendFrame({
        dialogId: id,
        seq: 1,
        protocol,
        payload: { ...payload, value: { phase: 'tampered' } },
        source: 'replay-tampered',
      });
      say('A 4th copy arrives, but this time with different contents', 'warn');
      await waitForTerminal(id, 6000);

      const view = viewOf(id);
      check('All 4 duplicate copies were blocked', view?.suppressed === 4, `blocked=${view?.suppressed}`);
      check('The work was still only done once', view?.sideEffects === 1, `work items=${view?.sideEffects}`);
      check('No extra work items were created by the duplicates', view?.sideEffects === baseline?.sideEffects, `${view?.sideEffects} = ${baseline?.sideEffects}`);
      check('The task finished successfully', view?.state === 'COMMITTED', `status=${view?.state}`);
    },

    5: async ({ id, protocol, assert: check }) => {
      sendFrame({ dialogId: id, seq: 1, protocol, payload: { step: 1 } });
      say('Packet 1 is processed', 'info');
      await sleep(220);

      addBlackhole(id, 2);
      addBlackhole(id, 3);
      sendFrame({ dialogId: id, seq: 2, protocol, payload: { step: 2 } });
      sendFrame({ dialogId: id, seq: 3, protocol, payload: { step: 3 } });
      say('Packets 2 and 3 disappear inside the network', 'warn');
      await sleep(220);

      sendFrame({ dialogId: id, seq: 4, protocol, payload: { step: 4 } });
      say('Packet 4 arrives, but packets 2 and 3 are still missing, so it waits', 'info');
      await sleep(420);

      const gapped = viewOf(id);
      check('The gap was spotted and packet 4 was held back', gapped?.buffered.includes(4) === true, `holding=${gapped?.buffered}`);
      check('The receiver knows it is still waiting for packet 2', gapped?.nextSeq === 2, `waiting for=${gapped?.nextSeq}`);
      check('Exactly packets 2 and 3 were identified as missing', gapped?.missing.length === 2, `missing=${gapped?.missing}`);

      clearBlackholes(id);
      say('The connection is working again, so the requested packets can arrive', 'info');
      await waitForTerminal(id, 7000);

      const view = viewOf(id);
      check('The missing packets arrived and everything is in order', view?.appliedOrder.join(',') === '1,2,3,4', `order=${view?.appliedOrder.join(', ')}`);
      check('The held-back packet was released', view?.buffered.length === 0, `still holding=${view?.buffered.length}`);
      check('All 4 work items completed with nothing repeated', view?.sideEffects === 4, `work items=${view?.sideEffects}`);
      check('The task finished successfully', view?.state === 'COMMITTED', `status=${view?.state}`);
    },
  };

  async function runScenario(scenarioId, { protocol = 'MCP' } = {}) {
    if (simRef.current.running) return null;
    const definition = SCENARIOS.find((item) => item.id === scenarioId);
    if (!definition) return null;

    const dialogId = `dlg-s${scenarioId}-${randomId(4)}`;
    const startedAt = Date.now();
    simRef.current = { running: scenarioId, dialogId, steps: [], assertions: [], startedAt, durationMs: null };

    say(`Demo ${scenarioId}: ${definition.title}`, 'head');
    say(`A fresh task is created and sent over the ${PROTOCOL_MAP[protocol].plain.toLowerCase()} channel`, 'info');

    try {
      await scenarioBody[scenarioId]({ id: dialogId, protocol, say, assert });
    } catch (error) {
      say(`harness error: ${error.message}`, 'fail');
      simRef.current.assertions.push({ label: 'harness executed without throwing', ok: false, detail: error.message, at: Date.now() });
    }

    const durationMs = Date.now() - startedAt;
    const assertions = simRef.current.assertions.slice();
    const passed = assertions.length > 0 && assertions.every((row) => row.ok);

    say(
      passed
        ? `Result: passed — all ${assertions.length} checks succeeded`
        : `Result: ${assertions.filter((r) => r.ok).length} of ${assertions.length} checks passed`,
      passed ? 'pass' : 'fail',
    );

    simRef.current.running = null;
    simRef.current.durationMs = durationMs;
    setSimulation({
      ...simRef.current,
      status: passed ? 'passed' : 'failed',
      steps: simRef.current.steps.slice(),
      assertions,
      durationMs,
    });
    setScenarioResults((prev) => ({
      ...prev,
      [scenarioId]: { status: passed ? 'passed' : 'failed', durationMs, assertions, dialogId, at: Date.now() },
    }));
    publish();
    return { passed, assertions, durationMs, dialogId };
  }

  async function runAllScenarios() {
    const results = [];
    for (const definition of SCENARIOS) {
      if (simRef.current.running) break;
      const result = await runScenario(definition.id, { protocol: definition.id % 2 === 0 ? 'A2A' : 'MCP' });
      if (result) results.push({ id: definition.id, ...result });
      await sleep(320);
    }
    return results;
  }

  function clearLogs() {
    store.current.logs = [];
    setLogs([]);
  }

  function resetEngine() {
    for (const id of timers.current) clearTimeout(id);
    timers.current.clear();
    store.current = createStore();
    simRef.current = { running: null, dialogId: null, steps: [], assertions: [], startedAt: null, durationMs: null };
    setLogs([]);
    setWire([]);
    setDialogs([]);
    setThroughput([]);
    setScenarioResults({});
    setSimulation({
      running: null,
      dialogId: null,
      steps: [],
      assertions: [],
      startedAt: null,
      durationMs: null,
      status: 'idle',
    });
    publish();
  }

  useEffect(() => {
    const watchdog = setInterval(watchdogTick, TIMING.WATCHDOG_TICK);
    return () => clearInterval(watchdog);
  }, []);

  useEffect(() => {
    const telemetry = setInterval(() => {
      const s = store.current;
      const jitter = (base, spread) => Math.max(1, Math.round(base + (Math.random() - 0.5) * spread));
      s.nodes.adapterA.rtt = jitter(11, 6);
      s.nodes.adapterB.rtt = jitter(19, 8);
      s.nodes.bridge.rtt = jitter(24, 12);
      s.nodes.storage.rtt = jitter(3, 2);
      s.nodes.adapterA.queue = [...s.dialogs.values()].filter((d) => d.state === 'PROCESSING').length;
      s.nodes.adapterB.queue = [...s.dialogs.values()].filter((d) => Object.keys(d.buffer).length > 0).length;
      s.nodes.bridge.queue = s.blocked ? 0 : s.packets % 7;
      Object.values(s.nodes).forEach((node) => {
        node.uptimeMs += TIMING.TELEMETRY_TICK;
      });
      const delta = s.packets - s.lastSamplePackets;
      s.lastSamplePackets = s.packets;
      s.pps = delta;
      s.throughput.push(delta);
      if (s.throughput.length > 40) s.throughput.shift();
      publish();
    }, TIMING.TELEMETRY_TICK);
    return () => clearInterval(telemetry);
  }, []);

  useEffect(
    () => () => {
      for (const id of timers.current) clearTimeout(id);
      timers.current.clear();
    },
    [],
  );

  return {
    logs,
    wire: wireEvents,
    dialogs,
    nodes,
    metrics,
    throughput,
    simulation,
    scenarioResults,
    dispatch,
    runScenario,
    runAllScenarios,
    clearLogs,
    clearBlackholes,
    resetEngine,
  };
}