/**
 * SimulationRuntime — the single host object the HTTP API talks to
 * (docs/API_DESIGN.md §1).
 *
 * Owns everything the tests' boot() helper builds — the sql.js handle over the
 * SQLite FILE, the transport, the side-effect tracker, Adapter A and Adapter B
 * — plus what must outlive simulated restarts: the event log, counters since
 * boot, and the mutation lock.
 *
 * Rules:
 *   - Every mutation runs inside withLock(); a second mutation while one is in
 *     progress fails immediately with RuntimeBusyError (never queued).
 *     Reads never take the lock.
 *   - Before calling Adapter A the runtime pre-checks the dialog: unknown →
 *     NotFoundError; terminal (where not allowed) → DialogTerminalError.  So
 *     Adapter A's untyped "not driven" error never reaches a caller.
 *   - Simulated drops are not exceptions: send/retry return a SendResult with
 *     delivery request_dropped | response_dropped (§4).
 *   - restart('A' | 'B') is always a FULL process restart (shared handle):
 *     close the handle, reopen the file, rebuild both adapters, recover().
 *
 * This layer adds no semantics: lifecycle, dedup and recovery are exactly
 * those of AdapterA / AdapterB / DialogManager.
 */

import fs   from 'node:fs';
import path from 'node:path';
import type { Database, SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../db/index.js';
import type { DbHandle } from '../db/index.js';
import { AdapterA } from '../adapters/AdapterA.js';
import { AdapterB, InMemorySideEffectTracker } from '../adapters/AdapterB.js';
import { MessageDroppedError } from '../adapters/Transport.js';
import type { AdapterErrorCode, AdapterResponse } from '../adapters/types.js';
import { DialogRepository } from '../repositories/DialogRepository.js';
import { RequestRepository } from '../repositories/RequestRepository.js';
import { OutboundRequestRepository } from '../repositories/OutboundRequestRepository.js';
import {
  DialogTerminalError,
  NotFoundError,
  ResetDisabledError,
  RuntimeBusyError,
} from '../errors.js';
import { LIFECYCLE_STATES, isTerminal } from '../types/index.js';
import type { DialogRecord, LifecycleState, OutboundRequestRecord } from '../types/index.js';
import { logger } from '../logger.js';
import { EventLog, newEpoch } from './EventLog.js';
import type { ApiEvent, EventPage, NewEvent } from './EventLog.js';
import { ObservedTransport } from './ObservedTransport.js';
import type { Delivery, Fault } from './ObservedTransport.js';

// ---------------------------------------------------------------------------
// Public types (docs/API_DESIGN.md §2, §4, §7)
// ---------------------------------------------------------------------------

export type { Fault, Delivery };

export interface RuntimeConfig {
  dbPath:          string;
  maxAttempts:     number;
  allowReset:      boolean;
  eventBufferSize: number;
}

export interface DialogSummary {
  dialog_id:               string;
  task_id:                 string;
  state:                   LifecycleState;
  restored:                boolean;
  terminal:                boolean;
  next_seq:                number;
  processed_count:         number;    // durable: rows in `requests`
  pending_seqs:            number[];  // durable: PENDING rows in `outbound_requests`
  side_effects_since_boot: number;    // tracker; resets on every restart
  duplicates_since_boot:   number;    // runtime counter; survives simulated restarts
}

export interface SendLogEntry {
  seq:      number;
  payload:  unknown;
  status:   'PENDING' | 'ACKED';
  attempts: number;
}

export interface ProcessedEntry {
  seq:          number;
  processed_at: string;
  result:       unknown;
}

export type LedgerStatus = 'acked' | 'processed_unacked' | 'pending_unprocessed';

export interface LedgerEntry {
  seq:      number;
  status:   LedgerStatus;
  attempts: number;
}

export interface DialogDetail {
  dialog:    DialogSummary;
  processed: ProcessedEntry[];
  send_log:  SendLogEntry[];
  ledger:    LedgerEntry[];
}

export type SendOutcome = 'ok' | 'duplicate' | 'rejected' | 'no_answer';

export interface SendResult {
  dialog_id:     string;
  task_id:       string;
  seq:           number;
  kind:          'send' | 'retry';
  delivery:      Delivery;
  outcome:       SendOutcome;
  response:      AdapterResponse | null;
  error_code?:   AdapterErrorCode;
  send_log:      SendLogEntry;
  dialog:        DialogSummary;
  dialog_failed: boolean;
  events:        { from: number; to: number };
}

export interface Metrics {
  processed_count:         number;                          // durable
  transport_attempts:      number;                          // durable
  dialogs_total:           number;                          // durable
  by_state:                Record<LifecycleState, number>;  // durable
  restored_total:          number;                          // durable
  side_effects_since_boot: number;                          // resets on restart
  duplicates_since_boot:   number;                          // lost on process exit / reset
  drops_since_boot:        number;                          // lost on process exit / reset
  uptime_ms:               number;
  booted_at:               string;
  restart_count:           number;
}

export type NodeStatus = { status: 'online' | 'restarting' };

export interface RuntimeInfo {
  booted_at:        string;
  restart_count:    number;
  epoch:            string;
  db_path_name:     string;
  max_attempts:     number;
  busy:             boolean;
  running_scenario: number | null;
  cursor:           number;
  uptime_ms:        number;
}

export interface RuntimeState {
  runtime:  RuntimeInfo;
  nodes:    { adapterA: NodeStatus; adapterB: NodeStatus; transport: NodeStatus; storage: NodeStatus };
  metrics:  Metrics;
  dialogs:  DialogSummary[];
}

export interface RecoveredSummary {
  dialog_id:    string;
  task_id:      string;
  state:        LifecycleState;
  next_seq:     number;
  pending_seqs: number[];
}

export const RESTART_NOTE = 'shared store: both adapter objects rebuilt from the SQLite file';

export interface RestartResult {
  target:    'A' | 'B';
  scope:     'process';
  note:      typeof RESTART_NOTE;
  recovered: RecoveredSummary[];
}

/** Unlocked operations, handed to withLock() callers (e.g. scenario scripts). */
export interface RuntimeOps {
  startDialog(taskId: string): Promise<DialogSummary>;
  send(dialogId: string, payload: unknown, fault?: Fault): Promise<SendResult>;
  retry(dialogId: string, seq: number, fault?: Fault): Promise<SendResult>;
  complete(dialogId: string): Promise<DialogSummary>;
  fail(dialogId: string, reason: string): Promise<DialogSummary>;
  restart(target: 'A' | 'B'): Promise<RestartResult>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Components {
  handle:    DbHandle;
  transport: ObservedTransport;
  tracker:   InMemorySideEffectTracker;
  adapterA:  AdapterA;
  adapterB:  AdapterB;
  dialogs:   DialogRepository;
  requests:  RequestRepository;
  outbound:  OutboundRequestRepository;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function toSendLogEntry(row: OutboundRequestRecord): SendLogEntry {
  return { seq: row.seq, payload: parseJson(row.payload), status: row.status, attempts: row.attempts };
}

// ---------------------------------------------------------------------------
// SimulationRuntime
// ---------------------------------------------------------------------------

export class SimulationRuntime {
  private readonly engine: SqlJsStatic;
  private readonly config: RuntimeConfig;
  private readonly log:    EventLog;
  private c!:              Components;

  private locked          = false;
  private restarting      = false;
  private closed          = false;
  private bootedAt        = new Date();
  private restartCount    = 0;
  private duplicatesTotal = 0;
  private dropsTotal      = 0;
  private readonly duplicatesByDialog = new Map<string, number>();

  private readonly ops: RuntimeOps = {
    startDialog: (taskId)               => this.doStartDialog(taskId),
    send:        (dialogId, payload, f) => this.doSend(dialogId, payload, f),
    retry:       (dialogId, seq, f)     => this.doRetry(dialogId, seq, f),
    complete:    (dialogId)             => this.doComplete(dialogId),
    fail:        (dialogId, reason)     => this.doFail(dialogId, reason),
    restart:     (target)               => this.doRestart(target),
  };

  private constructor(engine: SqlJsStatic, config: RuntimeConfig) {
    this.engine = engine;
    this.config = config;
    this.log    = new EventLog(config.eventBufferSize);
  }

  /**
   * Open the database file, build the components, and recover dialogs left
   * active by a previous run (same code path as restart()).
   */
  static async create(config: RuntimeConfig): Promise<SimulationRuntime> {
    const engine  = await initDb();
    const runtime = new SimulationRuntime(engine, config);
    runtime.boot();
    runtime.recoverAndEmit();
    return runtime;
  }

  // -------------------------------------------------------------------------
  // Lock
  // -------------------------------------------------------------------------

  get busy(): boolean {
    return this.locked;
  }

  /**
   * Run `fn` holding the runtime-wide mutation lock.  Throws RuntimeBusyError
   * immediately (synchronously at call time, before any await) if it is held.
   * `fn` receives the unlocked operations so it can perform several steps
   * under one lock.
   */
  async withLock<T>(fn: (ops: RuntimeOps) => Promise<T> | T): Promise<T> {
    this.assertOpen();
    if (this.locked) throw new RuntimeBusyError();
    this.locked = true;
    try {
      return await fn(this.ops);
    } finally {
      this.locked = false;
    }
  }

  // -------------------------------------------------------------------------
  // Mutations (each takes the lock)
  // -------------------------------------------------------------------------

  startDialog(taskId: string): Promise<DialogSummary> {
    return this.withLock(ops => ops.startDialog(taskId));
  }

  send(dialogId: string, payload: unknown, fault?: Fault): Promise<SendResult> {
    return this.withLock(ops => ops.send(dialogId, payload, fault));
  }

  retry(dialogId: string, seq: number, fault?: Fault): Promise<SendResult> {
    return this.withLock(ops => ops.retry(dialogId, seq, fault));
  }

  complete(dialogId: string): Promise<DialogSummary> {
    return this.withLock(ops => ops.complete(dialogId));
  }

  fail(dialogId: string, reason: string): Promise<DialogSummary> {
    return this.withLock(ops => ops.fail(dialogId, reason));
  }

  restart(target: 'A' | 'B'): Promise<RestartResult> {
    return this.withLock(ops => ops.restart(target));
  }

  /**
   * Demo-only reset: delete ONLY config.dbPath, rebuild from an empty file,
   * clear events and since-boot counters, switch to a new epoch.
   */
  async reset(): Promise<{ epoch: string }> {
    if (!this.config.allowReset) throw new ResetDisabledError();
    const file = this.config.dbPath;
    if (file !== ':memory:' && path.extname(file).toLowerCase() !== '.db') {
      throw new ResetDisabledError(`Reset refused: database path must end in .db (${path.basename(file)})`);
    }

    return this.withLock(() => {
      this.teardown();
      if (file !== ':memory:' && fs.existsSync(file)) fs.unlinkSync(file);

      this.duplicatesTotal = 0;
      this.dropsTotal      = 0;
      this.duplicatesByDialog.clear();
      this.restartCount    = 0;
      this.log.clear(newEpoch());

      this.boot();
      this.emit({ type: 'runtime_reset', actor: 'runtime', details: { epoch: this.log.epoch } });
      return { epoch: this.log.epoch };
    });
  }

  /** Release the database handle.  The runtime cannot be used afterwards. */
  close(): void {
    if (this.closed) return;
    this.teardown();
    this.closed = true;
  }

  // -------------------------------------------------------------------------
  // Reads (never take the lock)
  // -------------------------------------------------------------------------

  getState(): RuntimeState {
    this.assertOpen();
    const status: NodeStatus['status'] = this.restarting ? 'restarting' : 'online';
    return {
      runtime: {
        booted_at:        this.bootedAt.toISOString(),
        restart_count:    this.restartCount,
        epoch:            this.log.epoch,
        db_path_name:     path.basename(this.config.dbPath),
        max_attempts:     this.config.maxAttempts,
        busy:             this.locked,
        running_scenario: null,   // set by the scenario module (Phase 6c)
        cursor:           this.log.latestId,
        uptime_ms:        this.uptimeMs(),
      },
      nodes: {
        adapterA:  { status },
        adapterB:  { status },
        transport: { status },
        storage:   { status: 'online' },
      },
      metrics: this.getMetrics(),
      dialogs: this.listDialogs(),
    };
  }

  getMetrics(): Metrics {
    this.assertOpen();
    const counts   = this.c.dialogs.countByState();
    const byState  = Object.fromEntries(
      LIFECYCLE_STATES.map(s => [s, counts[s] ?? 0]),
    ) as Record<LifecycleState, number>;
    const all      = this.c.dialogs.findAll();

    return {
      processed_count:         this.c.requests.totalCount(),
      transport_attempts:      this.c.outbound.sumAttempts(),
      dialogs_total:           all.length,
      by_state:                byState,
      restored_total:          this.c.dialogs.countRestored(),
      side_effects_since_boot: all.reduce((n, d) => n + this.c.tracker.getProcessCount(d.dialog_id), 0),
      duplicates_since_boot:   this.duplicatesTotal,
      drops_since_boot:        this.dropsTotal,
      uptime_ms:               this.uptimeMs(),
      booted_at:               this.bootedAt.toISOString(),
      restart_count:           this.restartCount,
    };
  }

  /**
   * Dialog summaries, newest first.  dialogs has no timestamp column; Adapter A
   * generates ids as dlg-<Date.now()>-…, so reverse id order is creation order.
   */
  listDialogs(opts: { state?: LifecycleState; limit?: number } = {}): DialogSummary[] {
    this.assertOpen();
    const counts = this.c.requests.countPerDialog();
    return this.c.dialogs.findAll()
      .reverse()
      .filter(d => opts.state === undefined || d.state === opts.state)
      .slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER)
      .map(d => this.summarize(d, counts.get(d.dialog_id) ?? 0));
  }

  /** One dialog with its processed requests, send log and per-seq ledger. */
  getDialog(dialogId: string): DialogDetail {
    this.assertOpen();
    const record    = this.requireDialog(dialogId);
    const processed = this.c.requests.findByDialog(dialogId);
    const sendLog   = this.c.outbound.findByDialog(dialogId);
    const processedSeqs = new Set(processed.map(r => r.seq));

    return {
      dialog:    this.summarize(record, processed.length),
      processed: processed.map(r => ({ seq: r.seq, processed_at: r.processed_at, result: parseJson(r.result) })),
      send_log:  sendLog.map(toSendLogEntry),
      ledger:    sendLog.map(row => ({
        seq:      row.seq,
        attempts: row.attempts,
        status:   row.status === 'ACKED'
          ? 'acked'
          : processedSeqs.has(row.seq) ? 'processed_unacked' : 'pending_unprocessed',
      })),
    };
  }

  events(since?: number, limit?: number): EventPage {
    return this.log.since(since, limit);
  }

  /** @internal The live sql.js handle — for tests that tamper with memory. */
  get database(): Database {
    this.assertOpen();
    return this.c.handle.db;
  }

  // -------------------------------------------------------------------------
  // Unlocked implementations
  // -------------------------------------------------------------------------

  private async doStartDialog(taskId: string): Promise<DialogSummary> {
    const dialogId = this.c.adapterA.startDialog(taskId);
    this.emit({
      type: 'dialog_created', actor: 'A', dialog_id: dialogId, task_id: taskId,
      outcome: 'INITIATED', details: { state: 'INITIATED' },
    });
    return this.summary(dialogId);
  }

  private async doSend(dialogId: string, payload: unknown, fault?: Fault): Promise<SendResult> {
    const dialog = this.requireDialog(dialogId);
    if (isTerminal(dialog.state)) throw new DialogTerminalError(dialogId, dialog.state);

    const seq = this.c.outbound.maxSeq(dialogId) + 1;  // exactly what Adapter A will assign (lock held)
    const from = this.log.latestId + 1;
    this.emit({
      type: 'request_sent', actor: 'A', dialog_id: dialogId, task_id: dialog.task_id, seq,
      details: { attempts: 1 },
    });

    return this.deliverAndReport('send', dialog, seq, null, from, fault,
      () => this.c.adapterA.sendRequest(dialogId, payload));
  }

  private async doRetry(dialogId: string, seq: number, fault?: Fault): Promise<SendResult> {
    const dialog = this.requireDialog(dialogId);  // terminal is allowed: idempotent replay
    const row    = this.c.outbound.findByKey(dialogId, seq);
    if (row === null) throw new NotFoundError('Outbound request', `${dialogId}#${seq}`);

    const from = this.log.latestId + 1;
    this.emit({
      type: 'retry_sent', actor: 'A', dialog_id: dialogId, task_id: dialog.task_id, seq,
      details: { attempts: row.attempts + 1, send_log_status: row.status },
    });

    return this.deliverAndReport('retry', dialog, seq, row.status, from, fault,
      () => this.c.adapterA.retryRequest(dialogId, seq));
  }

  /**
   * Shared tail of send/retry: run the adapter call under one fault, turn a
   * MessageDroppedError into a delivery outcome, emit A-side events by
   * comparing state before/after, and build the SendResult.
   */
  private async deliverAndReport(
    kind:          'send' | 'retry',
    before:        DialogRecord,
    seq:           number,
    statusBefore:  OutboundRequestRecord['status'] | null,
    from:          number,
    fault:         Fault | undefined,
    call:          () => Promise<AdapterResponse>,
  ): Promise<SendResult> {
    const transport = this.c.transport;
    let response: AdapterResponse | null = null;
    let delivery: Delivery;

    try {
      response = await transport.withFault(fault, call);
      delivery = 'delivered';
    } catch (error) {
      if (!(error instanceof MessageDroppedError)) throw error;
      delivery = transport.lastCall.delivery ?? 'request_dropped';
    }

    const ids = { dialog_id: before.dialog_id, task_id: before.task_id, seq };
    const row = this.c.outbound.findByKey(before.dialog_id, seq)!;

    if (row.status === 'ACKED' && statusBefore !== 'ACKED') {
      this.emit({ type: 'request_acked', actor: 'A', ...ids });
    }

    // A-side transition: the retry budget may have moved the dialog to FAILED.
    const after = this.requireDialog(before.dialog_id);
    const mid   = transport.lastCall.stateAfterB ?? before.state;
    if (after.state !== mid) {
      this.emit({
        type: 'state_transition', actor: 'A', ...ids, outcome: after.state,
        details: {
          from:   mid,
          to:     after.state,
          reason: after.state === 'FAILED'
            ? `retry budget exhausted (attempts ${row.attempts})`
            : 'adapter A',
        },
      });
    }

    const outcome: SendOutcome = response === null
      ? 'no_answer'
      : response.status === 'ok'        ? 'ok'
      : response.status === 'duplicate' ? 'duplicate'
      : 'rejected';

    const result: SendResult = {
      ...ids,
      kind,
      delivery,
      outcome,
      response,
      send_log:      toSendLogEntry(row),
      dialog:        this.summary(before.dialog_id),
      dialog_failed: !isTerminal(before.state) && after.state === 'FAILED',
      events:        { from, to: this.log.latestId },
    };
    if (outcome === 'rejected') result.error_code = response!.error_code ?? 'INTERNAL';
    return result;
  }

  private async doComplete(dialogId: string): Promise<DialogSummary> {
    const before = this.requireDialog(dialogId);
    if (isTerminal(before.state)) throw new DialogTerminalError(dialogId, before.state);

    const after = this.c.adapterA.completeDialog(dialogId);
    this.emit({
      type: 'state_transition', actor: 'A', dialog_id: dialogId, task_id: after.task_id,
      outcome: after.state,
      details: { from: before.state, to: after.state, reason: 'completeDialog' },
    });
    return this.summary(dialogId);
  }

  private async doFail(dialogId: string, reason: string): Promise<DialogSummary> {
    const before = this.requireDialog(dialogId);
    if (isTerminal(before.state)) throw new DialogTerminalError(dialogId, before.state);

    const after = this.c.adapterA.failDialog(dialogId, reason);
    this.emit({
      type: 'state_transition', actor: 'A', dialog_id: dialogId, task_id: after.task_id,
      outcome: after.state,
      details: { from: before.state, to: after.state, reason: `failDialog: ${reason}` },
    });
    return this.summary(dialogId);
  }

  /**
   * Full process restart (§1): both adapters share one handle, so both are
   * rebuilt from the FILE whichever target is named.
   */
  private async doRestart(target: 'A' | 'B'): Promise<RestartResult> {
    const begin: Omit<RestartResult, 'recovered'> = { target, scope: 'process', note: RESTART_NOTE };
    this.emit({ type: 'adapter_restarted', actor: 'runtime', details: { ...begin, phase: 'begin' } });

    this.restarting = true;
    try {
      this.teardown();
      this.boot();
      this.restartCount += 1;
      const recovered = this.recoverAndEmit();
      this.emit({ type: 'adapter_restarted', actor: 'runtime', details: { ...begin, phase: 'end' } });
      return { ...begin, recovered };
    } finally {
      this.restarting = false;
    }
  }

  // -------------------------------------------------------------------------
  // Boot / teardown
  // -------------------------------------------------------------------------

  /** Open the file and build fresh components (no recovery). */
  private boot(): void {
    const handle  = openDatabase(this.config.dbPath, this.engine);
    const db      = handle.db;
    const file    = handle.dbPath;

    const tracker   = new InMemorySideEffectTracker();
    const dialogs   = new DialogRepository(db, file);
    const requests  = new RequestRepository(db, file);
    const outbound  = new OutboundRequestRepository(db, file);

    const transport = new ObservedTransport({
      emit:                 e  => this.emit(e),
      dialogState:          id => dialogs.findById(id)?.state ?? null,
      processedCount:       id => requests.countPerDialog().get(id) ?? 0,
      sideEffectsSinceBoot: id => tracker.getProcessCount(id),
    });
    const adapterB = new AdapterB(db, file, transport, tracker);
    const adapterA = new AdapterA(db, file, transport, { maxAttempts: this.config.maxAttempts });

    this.c = { handle, transport, tracker, adapterA, adapterB, dialogs, requests, outbound };
    this.bootedAt = new Date();
  }

  /** Discard every in-memory object and release the handle. */
  private teardown(): void {
    this.c.transport.unregisterRequestHandler();
    closeDatabase(this.c.handle.db);
  }

  /** AdapterA.recover() + one dialog_recovered event per resumed dialog. */
  private recoverAndEmit(): RecoveredSummary[] {
    return this.c.adapterA.recover().map(r => {
      const summary: RecoveredSummary = {
        dialog_id: r.dialog_id, task_id: r.task_id, state: r.state,
        next_seq: r.nextSeq, pending_seqs: r.pendingSeqs,
      };
      this.emit({
        type: 'dialog_recovered', actor: 'A', dialog_id: r.dialog_id, task_id: r.task_id,
        outcome: r.state,
        details: { state: r.state, next_seq: r.nextSeq, pending_seqs: r.pendingSeqs },
      });
      return summary;
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private emit(event: NewEvent): ApiEvent {
    const stored = this.log.append(event);

    if (event.type === 'duplicate_suppressed') {
      this.duplicatesTotal += 1;
      if (event.dialog_id !== undefined) {
        this.duplicatesByDialog.set(event.dialog_id, (this.duplicatesByDialog.get(event.dialog_id) ?? 0) + 1);
      }
    }
    if (event.type === 'request_dropped' || event.type === 'response_dropped') {
      this.dropsTotal += 1;
    }
    if (event.type === 'state_transition' && event.details?.['to'] === 'FAILED') {
      logger.info('runtime: dialog failed', { dialog_id: event.dialog_id, reason: event.details['reason'] });
    }
    return stored;
  }

  private requireDialog(dialogId: string): DialogRecord {
    const dialog = this.c.dialogs.findById(dialogId);
    if (dialog === null) throw new NotFoundError('Dialog', dialogId);
    return dialog;
  }

  private summary(dialogId: string): DialogSummary {
    const record = this.requireDialog(dialogId);
    return this.summarize(record, this.c.requests.countPerDialog().get(dialogId) ?? 0);
  }

  private summarize(d: DialogRecord, processedCount: number): DialogSummary {
    return {
      dialog_id:               d.dialog_id,
      task_id:                 d.task_id,
      state:                   d.state,
      restored:                d.restored,
      terminal:                isTerminal(d.state),
      next_seq:                this.c.outbound.maxSeq(d.dialog_id) + 1,
      processed_count:         processedCount,
      pending_seqs:            this.c.outbound.findPending(d.dialog_id).map(r => r.seq),
      side_effects_since_boot: this.c.tracker.getProcessCount(d.dialog_id),
      duplicates_since_boot:   this.duplicatesByDialog.get(d.dialog_id) ?? 0,
    };
  }

  private uptimeMs(): number {
    return Math.max(0, Date.now() - this.bootedAt.getTime());
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SimulationRuntime is closed');
  }
}
