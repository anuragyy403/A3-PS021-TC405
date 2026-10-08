import { useEffect, useRef, useState } from 'react';
import * as api from './client.js';
import {
  LOG_CAP,
  OFFLINE_NODES,
  WIRE_CAP,
  appendCapped,
  dirtyDialogIds,
  emptyMetrics,
  idleSimulation,
  mapEventToLog,
  mapEventToWire,
  mapScenarioProgress,
  mapScenarioResult,
  mapScenarioResults,
  mapState,
  noticeLog,
  resolveEventPage,
} from './mappers.js';

/**
 * Backend-driven engine (Phase 7a).
 *
 * Returns the same object contract as useCorrelationEngine(), but every value
 * comes from the backend API (docs/API_DESIGN.md).  The browser holds no
 * authoritative state: it polls
 *   GET /api/events?since=<cursor>   every EVENTS_MS while the tab is visible
 *   GET /api/state                   after new events, and at least every STATE_MAX_AGE_MS
 *   GET /api/dialogs/:id             only for dialogs touched by new events (ledgers)
 *   GET /api/scenarios               on load, after a scenario finishes, after a reset
 */

const EVENTS_MS = 400;
const HIDDEN_MS = 1500;
const STATE_MAX_AGE_MS = 2000;
const MAX_BACKOFF_MS = 5000;
const PAGE_LIMIT = 500;
const DETAIL_CONCURRENCY = 4;
export const SCENARIO_STEP_DELAY_MS = 400;

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function describeError(error) {
  if (error?.code === 'NETWORK') return 'backend unreachable';
  return `${error?.code ?? 'ERROR'}${error?.status ? ` (${error.status})` : ''}: ${error?.message ?? String(error)}`;
}

function createController(set) {
  let alive = false;
  let generation = 0;
  let timer = null;
  let polling = false;
  let pollAgain = false;
  let forceNext = false;           // poll once even while hidden (after a user action)
  let failures = 0;

  let cursor = 0;
  let epoch = null;
  let lastStateAt = 0;
  let needScenarios = true;
  let logs = [];
  let wire = [];
  const details = new Map();       // dialog_id → E4 detail
  let dirty = new Set();
  let allDirty = true;
  let lastState = null;

  // Scenario progress: `requested` = id this tab asked for (awaiting the HTTP
  // response); `live` = run being followed from scenario_* events.
  let requested = null;
  let live = null;                 // { scenarioId, runId, events: [], startedAt }
  let lastFinished = null;         // simulation object of the last finished run
  let scenarioResults = {};

  const guard = (fn) => (...args) => { if (alive) fn(...args); };
  const publish = {
    logs: guard(() => set.logs(logs)),
    wire: guard(() => set.wire(wire)),
    simulation: guard(() => set.simulation(computeSimulation())),
    scenarioResults: guard(() => set.scenarioResults({ ...scenarioResults })),
  };

  function computeSimulation() {
    if (live) {
      const progress = live.runId ? mapScenarioProgress(live.events, live.runId) : { steps: [], assertions: [] };
      return {
        running: live.scenarioId,
        dialogId: null,
        steps: progress.steps,
        assertions: progress.assertions,
        startedAt: live.startedAt,
        durationMs: null,
        status: 'running',
      };
    }
    if (requested !== null) {
      return { ...idleSimulation(), running: requested, status: 'running', startedAt: Date.now() };
    }
    if (lastState?.runningScenario) {
      return { ...idleSimulation(), running: lastState.runningScenario, status: 'running' };
    }
    return lastFinished ?? idleSimulation();
  }

  function notice(kind, msg, meta) {
    logs = appendCapped(logs, [noticeLog(kind, msg, meta)], LOG_CAP);
    publish.logs();
  }

  function clearLocal() {
    logs = [];
    wire = [];
    details.clear();
    dirty = new Set();
    allDirty = true;
    live = null;
    lastFinished = null;
    scenarioResults = {};
    needScenarios = true;
    publish.logs();
    publish.wire();
    publish.simulation();
    publish.scenarioResults();
  }

  function goOffline() {
    if (!alive) return;
    set.nodes({ ...OFFLINE_NODES });
    set.connected(false);
  }

  /** Feed a batch of events into logs, wire, dirty set and scenario progress. */
  function ingest(events, { backlog }) {
    if (!events.length) return;

    const newLogs = [];
    const newWire = [];
    for (const e of events) {
      const entry = mapEventToLog(e);
      if (entry) newLogs.push(entry);
      if (!backlog) {
        const w = mapEventToWire(e);
        if (w) newWire.push(w);
      }
    }
    logs = appendCapped(logs, newLogs, LOG_CAP);
    wire = appendCapped(wire, newWire, WIRE_CAP);
    publish.logs();
    if (newWire.length) publish.wire();

    for (const id of dirtyDialogIds(events)) dirty.add(id);

    if (backlog) return;
    let simChanged = false;
    for (const e of events) {
      const d = e.details ?? {};
      if (e.type === 'scenario_started') {
        // Follow the run this tab requested, or any run started elsewhere.
        if (requested === null || requested === d.scenario_id) {
          live = { scenarioId: d.scenario_id, runId: d.run_id, events: [], startedAt: Date.parse(e.at) || Date.now() };
          simChanged = true;
        }
      } else if (live && d.run_id === live.runId && e.type.startsWith('scenario_')) {
        live.events.push(e);
        simChanged = true;
        if (e.type === 'scenario_finished') {
          needScenarios = true;
          if (requested === null) {
            // Started by another client: keep what we followed as the final view.
            const p = mapScenarioProgress(live.events, live.runId);
            lastFinished = {
              running: null, dialogId: null, steps: p.steps, assertions: p.assertions,
              startedAt: live.startedAt, durationMs: p.finished?.durationMs ?? null,
              status: p.finished?.status ?? 'failed',
            };
            live = null;
          }
        }
      } else if (e.type === 'runtime_reset') {
        needScenarios = true;
      }
    }
    if (simChanged) publish.simulation();
  }

  async function fetchDetails(ids) {
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          details.set(id, await api.getDialog(id));
        } catch (error) {
          if (error?.status === 404) details.delete(id);
          else throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, worker));
  }

  async function refreshState() {
    const raw = await api.getState();
    const ids = raw.dialogs.map((d) => d.dialog_id);
    const known = new Set(ids);
    for (const id of [...details.keys()]) if (!known.has(id)) details.delete(id);

    const toFetch = allDirty ? ids : ids.filter((id) => dirty.has(id) || !details.has(id));
    await fetchDetails(toFetch);
    allDirty = false;
    dirty = new Set();

    lastState = mapState(raw, details);
    lastStateAt = Date.now();
    if (!alive) return;
    set.dialogs(lastState.dialogs);
    set.metrics(lastState.metrics);
    set.nodes(lastState.nodes);
    set.connected(true);
    publish.simulation();

    if (needScenarios) {
      needScenarios = false;
      scenarioResults = mapScenarioResults(await api.listScenarios());
      publish.scenarioResults();
    }
  }

  async function pollOnce() {
    let page = await api.getEvents(cursor, PAGE_LIMIT);
    let backlog = epoch === null;

    const decision = resolveEventPage(page, epoch);
    if (decision.reset) clearLocal();
    if (decision.refetchFrom !== null) {
      cursor = decision.refetchFrom;
      page = await api.getEvents(cursor, PAGE_LIMIT);
      backlog = true;   // re-read history: show it in the feed, do not animate it
    }
    epoch = page.epoch;

    ingest(page.events, { backlog });
    cursor = page.cursor;

    if (page.events.length || allDirty || Date.now() - lastStateAt >= STATE_MAX_AGE_MS) {
      await refreshState();
    }
    return page.events.length >= PAGE_LIMIT;   // more to read
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (alive) timer = setTimeout(loop, ms);
  }

  async function loop() {
    if (!alive) return;
    if (polling) { pollAgain = true; return; }
    polling = true;
    const gen = generation;
    let next = EVENTS_MS;
    try {
      if (isHidden() && !forceNext) {
        next = HIDDEN_MS;
      } else {
        forceNext = false;
        const more = await pollOnce();
        failures = 0;
        if (more) next = 0;
      }
    } catch {
      failures += 1;
      goOffline();
      next = Math.min(EVENTS_MS * 2 ** failures, MAX_BACKOFF_MS);
    } finally {
      polling = false;
    }
    if (gen !== generation || !alive) return;
    if (pollAgain) { pollAgain = false; next = 0; }
    schedule(next);
  }

  const onVisibility = () => { if (!isHidden()) pollNow(); };

  /** Poll as soon as possible — also in a hidden tab, because the user just acted. */
  function pollNow() {
    if (!alive) return;
    forceNext = true;
    if (polling) { pollAgain = true; return; }
    schedule(0);
  }

  return {
    start() {
      alive = true;
      generation += 1;
      forceNext = true;   // initial load happens even in a background tab
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
      schedule(0);
    },
    stop() {
      alive = false;
      generation += 1;
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    },

    async runScenario(id) {
      if (requested !== null) {
        notice('error', `demo ${id} not started · demo ${requested} is still running`);
        return null;
      }
      requested = id;
      live = null;
      publish.simulation();
      pollNow();
      try {
        const result = await api.runScenario(id, { step_delay_ms: SCENARIO_STEP_DELAY_MS });
        const mapped = mapScenarioResult(result);
        lastFinished = mapped.simulation;
        scenarioResults = { ...scenarioResults, [id]: mapped.result };
        publish.scenarioResults();
        return {
          passed: result.status === 'passed',
          assertions: mapped.result.assertions,
          durationMs: result.duration_ms,
          dialogId: mapped.result.dialogId,
        };
      } catch (error) {
        notice('error', error?.code === 'RUNTIME_BUSY'
          ? `demo ${id} not started · the backend is busy with another operation (409 RUNTIME_BUSY)`
          : `demo ${id} could not run · ${describeError(error)}`, { code: error?.code ?? null });
        return null;
      } finally {
        requested = null;
        live = null;
        publish.simulation();
        pollNow();
      }
    },

    async runAllScenarios() {
      const results = [];
      for (const id of [1, 2, 3, 4, 5]) {
        if (!alive) break;
        const result = await this.runScenario(id);
        if (result) results.push({ id, ...result });
      }
      return results;
    },

    async reset() {
      try {
        await api.resetRuntime();
        clearLocal();
        epoch = null;   // next page is read as fresh history
        cursor = 0;
      } catch (error) {
        notice('error', error?.code === 'RESET_DISABLED'
          ? 'reset refused by the backend (403 RESET_DISABLED)'
          : `reset failed · ${describeError(error)}`, { code: error?.code ?? null });
      } finally {
        pollNow();
      }
    },

    clearLogs() {
      logs = [];
      publish.logs();
    },

    manualNotice() {
      notice('success', 'manual sending is not available in live-backend mode yet · use the demonstrations (manual controls arrive in Phase 7b)');
    },
  };
}

export function useBackendEngine() {
  const [logs, setLogs] = useState([]);
  const [wire, setWire] = useState([]);
  const [dialogs, setDialogs] = useState([]);
  const [nodes, setNodes] = useState(() => ({ ...OFFLINE_NODES }));
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [simulation, setSimulation] = useState(idleSimulation);
  const [scenarioResults, setScenarioResults] = useState({});
  const [connected, setConnected] = useState(false);

  const controller = useRef(null);
  if (controller.current === null) {
    controller.current = createController({
      logs: setLogs,
      wire: setWire,
      dialogs: setDialogs,
      nodes: setNodes,
      metrics: setMetrics,
      simulation: setSimulation,
      scenarioResults: setScenarioResults,
      connected: setConnected,
    });
  }

  useEffect(() => {
    const ctl = controller.current;
    ctl.start();
    return () => ctl.stop();
  }, []);

  const ctl = controller.current;
  return {
    logs,
    wire,
    dialogs,
    nodes,
    metrics,
    throughput: [],               // no backend source
    simulation,
    scenarioResults,
    connected,
    dispatch: () => ctl.manualNotice(),
    runScenario: (id) => ctl.runScenario(id),
    runAllScenarios: () => ctl.runAllScenarios(),
    clearLogs: () => ctl.clearLogs(),
    clearBlackholes: () => ctl.manualNotice(),
    resetEngine: () => ctl.reset(),
  };
}
