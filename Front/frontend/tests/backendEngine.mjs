/**
 * useBackendEngine tests (Phase 7b).  node tests/backendEngine.mjs
 *
 * Mounts the real hook inside a jsdom document against a scripted FAKE backend:
 * globalThis.fetch is replaced, nothing talks to a real server.  Timings are
 * shortened through useBackendEngine({ timing }).  The JSX components
 * (ManualControls, App) are bundled with esbuild exactly like
 * tests/conformance.mjs does.
 */
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* Track the engine's poll timers (setTimeout(loop, ms)) so unmount can be checked. */
const loopTimers = new Set();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (typeof fn === 'function' && fn.name === 'loop') {
    const t = realSetTimeout(() => { loopTimers.delete(t); fn(...args); }, ms);
    loopTimers.add(t);
    return t;
  }
  return realSetTimeout(fn, ms, ...args);
};
globalThis.clearTimeout = (t) => { loopTimers.delete(t); return realClearTimeout(t); };

/* document.visibilityState is read-only in jsdom: shim it so tests can hide the tab. */
let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
function setVisibility(value) {
  visibility = value;
  document.dispatchEvent(new window.Event('visibilitychange'));
}

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { useBackendEngine, MANUAL_PAYLOAD } = await import('../src/api/useBackendEngine.js');
const { errorMessage } = await import('../src/api/messages.js');

const h = React.createElement;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

const consoleErrors = [];
const realConsoleError = console.error;
console.error = (...args) => consoleErrors.push(args.map(String).join(' '));

const results = [];
async function test(label, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`${GREEN}PASS${RESET}  ${label}`);
  } catch (error) {
    results.push(false);
    console.log(`${RED}FAIL${RESET}  ${label}\n      ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
function check(ok, message) {
  if (!ok) throw new Error(message);
}
function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  actual   ${a}`);
}

async function wait(ms) {
  await act(async () => { await sleep(ms); });
}
async function waitFor(predicate, label, timeoutMs = 1500) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// Fake backend
// ---------------------------------------------------------------------------

const TERMINAL = new Set(['COMMITTED', 'RECOVERED', 'FAILED']);

function createFakeBackend() {
  const srv = {
    epoch: 'ep-1',
    events: [],
    lastId: 0,
    dialogs: new Map(),          // dialog_id → { summary, ledger }
    busy: false,
    running: null,
    down: false,
    calls: [],
    handlers: new Map(),         // 'METHOD /path' → (body) => { status, json } | Promise
    scenarios: { scenarios: [] },
  };

  srv.emit = (type, extra = {}) => {
    srv.lastId += 1;
    const e = { id: srv.lastId, at: new Date().toISOString(), type, actor: 'A', details: {}, ...extra };
    srv.events.push(e);
    return e;
  };
  srv.addDialog = (id, taskId, state = 'PROCESSING', ledger = [], extra = {}) => {
    const pending = ledger.filter((r) => r.status !== 'acked').map((r) => r.seq);
    srv.dialogs.set(id, {
      summary: {
        dialog_id: id, task_id: taskId, state, restored: false, terminal: TERMINAL.has(state),
        next_seq: ledger.length + 1, processed_count: ledger.filter((r) => r.status !== 'pending_unprocessed').length,
        pending_seqs: pending, side_effects_since_boot: 0, duplicates_since_boot: 0, ...extra,
      },
      ledger,
    });
  };
  srv.on = (key, fn) => srv.handlers.set(key, fn);
  srv.callsTo = (method, prefix) => srv.calls.filter((c) => c.method === method && c.path.startsWith(prefix));
  srv.mutations = () => srv.calls.filter((c) => c.method !== 'GET');

  function stateBody() {
    const summaries = [...srv.dialogs.values()].map((d) => d.summary);
    const byState = { INITIATED: 0, PROCESSING: 0, COMMITTED: 0, RECOVERED: 0, FAILED: 0 };
    for (const s of summaries) byState[s.state] += 1;
    return {
      runtime: { booted_at: '2026-10-08T10:00:00.000Z', restart_count: 0, epoch: srv.epoch, busy: srv.busy, running_scenario: srv.running, cursor: srv.lastId, uptime_ms: 1 },
      nodes: { adapterA: { status: 'online' }, adapterB: { status: 'online' }, transport: { status: 'online' }, storage: { status: 'online' } },
      metrics: {
        processed_count: 0, transport_attempts: 0, dialogs_total: summaries.length, by_state: byState, restored_total: 0,
        side_effects_since_boot: 0, duplicates_since_boot: 0, drops_since_boot: 0, uptime_ms: 1, booted_at: '2026-10-08T10:00:00.000Z', restart_count: 0,
      },
      dialogs: summaries,
    };
  }

  srv.stateBody = stateBody;

  function route(method, path, query, body) {
    const key = `${method} ${path}`;
    if (srv.handlers.has(key)) return srv.handlers.get(key)(body);
    if (method === 'GET' && path === '/api/events') {
      const since = Number(query.get('since') ?? 0);
      const limit = Number(query.get('limit') ?? 200);
      const oldest = srv.events[0]?.id ?? srv.lastId + 1;
      const page = srv.events.filter((e) => e.id > since).slice(0, limit);
      return {
        status: 200,
        json: { epoch: srv.epoch, events: page, cursor: page.length ? page[page.length - 1].id : since, oldest_available: oldest, truncated: since < oldest - 1 },
      };
    }
    if (method === 'GET' && path === '/api/state') return { status: 200, json: stateBody() };
    if (method === 'GET' && path === '/api/scenarios') return { status: 200, json: srv.scenarios };
    const detail = /^\/api\/dialogs\/([^/]+)$/.exec(path);
    if (method === 'GET' && detail) {
      const d = srv.dialogs.get(decodeURIComponent(detail[1]));
      if (!d) return { status: 404, json: { error: 'DIALOG_NOT_FOUND', message: 'not found', status: 404 } };
      return { status: 200, json: { dialog: d.summary, processed: [], send_log: [], ledger: d.ledger } };
    }
    return { status: 500, json: { error: 'INTERNAL_SERVER_ERROR', message: `fake backend has no route for ${key}`, status: 500 } };
  }

  srv.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://localhost');
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    srv.calls.push({ method, path: u.pathname, query: u.search, body, at: Date.now() });
    if (srv.down === 'proxy') return { ok: false, status: 500, text: async () => '' };   // Vite proxy, backend stopped
    if (srv.down) throw new TypeError('fetch failed');
    const { status, json } = await route(method, u.pathname, u.searchParams, body);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  return srv;
}

let server = createFakeBackend();
globalThis.fetch = (...args) => server.fetch(...args);

const TIMING = { eventsMs: 15, hiddenMs: 20, stateMaxAgeMs: 60, maxBackoffMs: 200, scenarioStepDelayMs: 0 };

async function mountHook(timing = TIMING) {
  const box = { current: null };
  function Harness() {
    box.current = useBackendEngine({ timing });
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(h(Harness)); });
  return {
    read: () => box.current,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/** Fresh fake backend with two dialogs and some history, hook mounted and loaded. */
async function loaded() {
  server = createFakeBackend();
  server.addDialog('D1', 'T1', 'PROCESSING', [{ seq: 1, status: 'acked', attempts: 1 }, { seq: 2, status: 'pending_unprocessed', attempts: 1 }]);
  server.addDialog('D2', 'T2', 'COMMITTED', [{ seq: 1, status: 'acked', attempts: 1 }]);
  server.emit('dialog_created', { dialog_id: 'D1', task_id: 'T1', details: { state: 'INITIATED' } });
  server.emit('request_sent', { dialog_id: 'D1', task_id: 'T1', seq: 1 });
  server.emit('dialog_created', { dialog_id: 'D2', task_id: 'T2', details: { state: 'INITIATED' } });
  const hook = await mountHook();
  await waitFor(() => hook.read().connected && hook.read().dialogs.length === 2, 'initial load');
  await waitFor(() => server.callsTo('GET', '/api/scenarios').length === 1, 'scenarios loaded');
  return hook;
}

const sendResult = (over = {}) => ({
  dialog_id: 'D1', task_id: 'T1', seq: 3, kind: 'send', delivery: 'delivered', outcome: 'ok', response: null,
  send_log: { seq: 3, status: 'ACKED', attempts: 1 }, dialog: { dialog_id: 'D1', task_id: 'T1', state: 'PROCESSING' },
  dialog_failed: false, events: { from: 1, to: 2 }, ...over,
});
const apiError = (status, code, message, details) => ({ status, json: { error: code, message, status, ...(details ? { details } : {}) } });

console.log(`\n${BOLD}Nighthawks - backend engine hook tests (fake fetch)${RESET}\n`);

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

await test('initial load: events from 0, state, scenarios, and a ledger for every dialog', async () => {
  const hook = await loaded();
  try {
    const first = server.calls[0];
    equal([first.method, first.path, first.query], ['GET', '/api/events', '?since=0&limit=500'], 'first call reads the whole event log');
    check(server.callsTo('GET', '/api/state').length >= 1, 'GET /api/state was called');
    equal(server.callsTo('GET', '/api/dialogs/').map((c) => c.path).sort(), ['/api/dialogs/D1', '/api/dialogs/D2'], 'one detail fetch per dialog');
    const e = hook.read();
    equal(e.dialogs.map((d) => [d.id, d.state, d.ledger.length]), [['D1', 'PROCESSING', 2], ['D2', 'COMMITTED', 1]], 'dialogs + ledgers mapped');
    check(e.logs.length === 3 && e.logs.every((l) => l.origin === 'backend'), `3 backend log entries (got ${e.logs.length})`);
    equal(e.wire, [], 'backlog is not animated');
    equal(e.nodes.adapterA.status, 'online', 'nodes online');
    equal(e.busy, false, 'not busy');
  } finally {
    await hook.unmount();
  }
});

await test('cursor advances across polls; only new events are requested', async () => {
  const hook = await loaded();
  try {
    await waitFor(() => server.calls.some((c) => c.path === '/api/events' && c.query.startsWith('?since=3&')), 'poll from cursor 3');
    server.emit('request_sent', { dialog_id: 'D1', task_id: 'T1', seq: 2 });
    server.emit('request_dropped', { dialog_id: 'D1', task_id: 'T1', seq: 2, actor: 'transport' });
    await waitFor(() => server.calls.some((c) => c.path === '/api/events' && c.query.startsWith('?since=5&')), 'poll from cursor 5');
    check(hook.read().logs.length === 5, `5 log entries (got ${hook.read().logs.length})`);
    const sinces = server.callsTo('GET', '/api/events').map((c) => Number(/since=(\d+)/.exec(c.query)[1]));
    check(sinces.every((s, i) => i === 0 || s >= sinces[i - 1]), `cursor never goes back: ${sinces.join(',')}`);
  } finally {
    await hook.unmount();
  }
});

await test('dirty ledgers: only dialogs named in new events are refetched', async () => {
  const hook = await loaded();
  try {
    // A state refresh without new events (stateMaxAgeMs) must not refetch ledgers.
    const before = server.callsTo('GET', '/api/dialogs/').length;
    const states = server.callsTo('GET', '/api/state').length;
    await waitFor(() => server.callsTo('GET', '/api/state').length >= states + 2, 'two periodic state refreshes');
    equal(server.callsTo('GET', '/api/dialogs/').length, before, 'periodic state refresh fetched no ledgers');

    const mark = server.calls.length;
    server.dialogs.get('D2').ledger.push({ seq: 2, status: 'acked', attempts: 2 });
    server.emit('retry_sent', { dialog_id: 'D2', task_id: 'T2', seq: 1, details: { attempts: 2 } });
    await waitFor(() => hook.read().dialogs.find((d) => d.id === 'D2').ledger.length === 2, 'D2 ledger refreshed');
    await wait(40);
    equal(server.calls.slice(mark).filter((c) => c.path.startsWith('/api/dialogs/')).map((c) => c.path), ['/api/dialogs/D2'], 'only D2 refetched');
  } finally {
    await hook.unmount();
  }
});

await test('epoch change: feed cleared, cursor reset to the oldest retained event', async () => {
  const hook = await loaded();
  try {
    await waitFor(() => server.calls.some((c) => c.query.startsWith('?since=3&')), 'caught up');
    // Backend reset: new epoch, new history from id 1.
    server.epoch = 'ep-2';
    server.events = [];
    server.lastId = 0;
    server.dialogs.clear();
    server.emit('runtime_reset', { actor: 'runtime', details: { epoch: 'ep-2' } });
    const mark = server.calls.length;
    await waitFor(() => hook.read().logs.length === 1 && hook.read().dialogs.length === 0, 'feed cleared and refilled');
    const eventsCalls = server.calls.slice(mark).filter((c) => c.path === '/api/events').map((c) => c.query);
    check(eventsCalls.includes('?since=0&limit=500'), `re-read from 0 after the epoch change (${eventsCalls.join(' ')})`);
    equal(hook.read().logs[0].meta?.event_type, 'runtime_reset', 'only the new epoch is shown');
  } finally {
    await hook.unmount();
  }
});

await test('truncated page: refetch from oldest_available - 1, old feed dropped', async () => {
  const hook = await loaded();
  try {
    await waitFor(() => server.calls.some((c) => c.query.startsWith('?since=3&')), 'caught up');
    // Simulate: we miss events 4..6 because the server evicted them before we polled.
    hook.read();
    for (let i = 0; i < 5; i++) server.emit('request_sent', { dialog_id: 'D1', task_id: 'T1', seq: 10 + i });
    server.events = server.events.filter((e) => e.id >= 7);   // ids 7, 8 retained
    const mark = server.calls.length;
    await waitFor(() => server.calls.slice(mark).some((c) => c.query === '?since=6&limit=500'), 'refetch from oldest-1');
    await waitFor(() => hook.read().logs.length === 2, `feed holds only retained events (got ${hook.read().logs.length})`);
  } finally {
    await hook.unmount();
  }
});

await test('network failure: nodes offline, backoff grows, recovers by itself', async () => {
  const hook = await loaded();
  try {
    server.down = true;
    const mark = server.calls.length;
    await waitFor(() => !hook.read().connected, 'disconnected');
    equal(Object.values(hook.read().nodes).map((n) => n.status), ['offline', 'offline', 'offline', 'offline'], 'all nodes offline');
    await waitFor(() => server.calls.length - mark >= 5, 'five failed attempts', 2500);
    const times = server.calls.slice(mark).map((c) => c.at);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    // expected 30, 60, 120, 200(cap): 15 * 2^n capped at 200
    check(gaps[1] > gaps[0] && gaps[2] > gaps[1], `gaps grow: ${gaps.join(',')}`);
    check(Math.max(...gaps) <= TIMING.maxBackoffMs + 60, `gaps capped near ${TIMING.maxBackoffMs}: ${gaps.join(',')}`);

    const fail = await hook.read().actions.send('D1', '');
    equal([fail.ok, fail.code, fail.message], [false, 'NETWORK', errorMessage({ code: 'NETWORK' })], 'manual action reports NETWORK');

    server.down = false;
    await waitFor(() => hook.read().connected && hook.read().nodes.adapterA.status === 'online', 'reconnected', 1500);
  } finally {
    await hook.unmount();
  }
});

await test('backend stopped behind the dev proxy (500, empty body) → NETWORK, not a server error', async () => {
  const hook = await loaded();
  try {
    server.down = 'proxy';
    await waitFor(() => !hook.read().connected, 'disconnected');
    const fail = await hook.read().actions.complete('D1');
    equal([fail.ok, fail.code, fail.message], [false, 'NETWORK', errorMessage({ code: 'NETWORK' })], 'proxy 500 without a body reads as unreachable');
    server.on('POST /api/dialogs/D1/fail', () => apiError(500, 'INTERNAL_SERVER_ERROR', 'boom'));
    server.down = false;
    await waitFor(() => hook.read().connected, 'reconnected');
    const real = await hook.read().actions.abort('D1', 'x');
    equal(real.code, 'INTERNAL_SERVER_ERROR', 'a real backend 500 (JSON body) stays INTERNAL_SERVER_ERROR');
  } finally {
    await hook.unmount();
  }
});

await test('hidden tab: no polling, but a manual action forces one poll', async () => {
  const hook = await loaded();
  try {
    setVisibility('hidden');
    await wait(40);
    const idle = server.callsTo('GET', '/api/events').length;
    await wait(120);
    equal(server.callsTo('GET', '/api/events').length, idle, 'no event polls while hidden');

    server.on('POST /api/dialogs/D1/requests', () => {
      server.emit('request_sent', { dialog_id: 'D1', task_id: 'T1', seq: 3 });
      return { status: 200, json: sendResult() };
    });
    await act(async () => { await hook.read().actions.send('D1', ''); });
    await waitFor(() => server.callsTo('GET', '/api/events').length > idle, 'forced poll after the action');
    await waitFor(() => hook.read().logs.some((l) => l.meta?.event_type === 'request_sent' && l.meta.sequence_no === 3), 'event of the action shown');
    const afterForced = server.callsTo('GET', '/api/events').length;
    await wait(120);
    equal(server.callsTo('GET', '/api/events').length, afterForced, 'back to idle after the forced poll');
  } finally {
    setVisibility('visible');
    await hook.unmount();
  }
});

await test('busy: runtime busy / running scenario from /api/state set engine.busy', async () => {
  const hook = await loaded();
  try {
    server.busy = true;
    server.running = 3;
    await waitFor(() => hook.read().busy === true, 'busy from state');
    equal(hook.read().simulation.running, 3, 'running scenario followed');
    server.busy = false;
    server.running = null;
    await waitFor(() => hook.read().busy === false, 'not busy again');
  } finally {
    await hook.unmount();
  }
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

await test('scenario: live progress from scenario_* events, then the final result', async () => {
  const hook = await loaded();
  try {
    const result = JSON.parse(await readFile(join(process.cwd(), 'tests', 'fixtures', 'scenario-result-1.json'), 'utf8'));
    let release;
    server.on('POST /api/scenarios/1/run', () => new Promise((resolve) => { release = resolve; }));

    let running;
    await act(async () => { running = hook.read().runScenario(1); });
    await waitFor(() => hook.read().busy && hook.read().simulation.running === 1, 'running + busy');
    equal(server.callsTo('POST', '/api/scenarios/1/run')[0].body, { step_delay_ms: 0 }, 'run body carries step_delay_ms');

    const run = { scenario_id: 1, run_id: result.run_id };
    server.emit('scenario_started', { actor: 'scenario', details: { ...run, title: result.title } });
    server.emit('scenario_step', { actor: 'scenario', details: { ...run, text: 'step one', tone: 'head' } });
    server.emit('scenario_assertion', { actor: 'scenario', details: { ...run, label: 'first check', ok: true } });
    await waitFor(() => hook.read().simulation.steps.length === 1 && hook.read().simulation.assertions.length === 1, 'live steps/assertions');
    equal(hook.read().simulation.status, 'running', 'still running');
    equal(hook.read().simulation.steps[0].text, 'step one', 'step text');

    server.emit('scenario_finished', { actor: 'scenario', details: { ...run, status: 'passed', duration_ms: result.duration_ms } });
    let outcome;
    await act(async () => { release({ status: 200, json: result }); outcome = await running; });
    equal([outcome.passed, outcome.durationMs], [true, result.duration_ms], 'runScenario resolves with the result');
    const sim = hook.read().simulation;
    equal([sim.running, sim.status, sim.steps.length], [null, 'passed', result.steps.length], 'final view = ScenarioResult');
    equal(hook.read().scenarioResults[1]?.status, 'passed', 'scenarioResults updated');
    await waitFor(() => hook.read().busy === false, 'not busy after the run');
  } finally {
    await hook.unmount();
  }
});

await test('scenario RUNTIME_BUSY → dismissible banner + feed notice, no crash', async () => {
  const hook = await loaded();
  try {
    server.on('POST /api/scenarios/2/run', () => apiError(409, 'RUNTIME_BUSY', 'busy'));
    let outcome;
    await act(async () => { outcome = await hook.read().runScenario(2); });
    equal(outcome, null, 'resolves to null');
    equal(hook.read().banner?.text, `Demo 2 did not run: ${errorMessage({ code: 'RUNTIME_BUSY' })}`, 'banner text');
    check(hook.read().logs.some((l) => /409 RUNTIME_BUSY/.test(l.msg)), 'feed notice');
    await act(async () => { hook.read().dismissBanner(); });
    equal(hook.read().banner, null, 'banner dismissed');
  } finally {
    await hook.unmount();
  }
});

// ---------------------------------------------------------------------------
// Manual actions: exactly one API call each
// ---------------------------------------------------------------------------

await test('actions: method, path and JSON body; one call per action; result line', async () => {
  const hook = await loaded();
  try {
    server.on('POST /api/dialogs', (body) => ({ status: 201, json: { dialog: { dialog_id: 'D9', task_id: body.task_id, state: 'INITIATED' } } }));
    server.on('POST /api/dialogs/D1/requests', (body) => ({
      status: 200,
      json: sendResult({
        delivery: body.fault === 'drop_request' ? 'request_dropped' : body.fault === 'drop_response' ? 'response_dropped' : 'delivered',
        outcome: body.fault ? 'no_answer' : 'ok',
      }),
    }));
    server.on('POST /api/dialogs/D1/requests/2/retry', (body) => ({
      status: 200, json: sendResult({ kind: 'retry', seq: 2, delivery: body.fault ? 'response_dropped' : 'delivered', outcome: body.fault ? 'no_answer' : 'duplicate' }),
    }));
    server.on('POST /api/dialogs/D1/complete', () => ({ status: 200, json: { dialog: { dialog_id: 'D1', task_id: 'T1', state: 'COMMITTED' } } }));
    server.on('POST /api/dialogs/D1/fail', () => ({ status: 200, json: { dialog: { dialog_id: 'D1', task_id: 'T1', state: 'FAILED' } } }));
    for (const adapter of ['A', 'B']) {
      server.on(`POST /api/adapters/${adapter}/restart`, () => ({
        status: 200,
        json: { target: adapter, scope: 'process', note: 'shared store', recovered: [{ dialog_id: 'D1', task_id: 'T1', state: 'PROCESSING', next_seq: 4, pending_seqs: [3] }] },
      }));
    }

    const a = hook.read().actions;
    const cases = [
      [() => a.createTask('T9'), 'POST', '/api/dialogs', { task_id: 'T9' }, 'new task T9 · D9 · INITIATED'],
      [() => a.send('D1', ''), 'POST', '/api/dialogs/D1/requests', { payload: MANUAL_PAYLOAD }, 'seq 3 · processed · work done · reply received · task PROCESSING'],
      [() => a.send('D1', 'drop_request'), 'POST', '/api/dialogs/D1/requests', { payload: MANUAL_PAYLOAD, fault: 'drop_request' }, 'seq 3 · request lost · B never saw it · retry it · task PROCESSING'],
      [() => a.send('D1', 'drop_response'), 'POST', '/api/dialogs/D1/requests', { payload: MANUAL_PAYLOAD, fault: 'drop_response' }, 'seq 3 · reply lost · B processed it · retry it to get the answer · task PROCESSING'],
      [() => a.retry('D1', 2, ''), 'POST', '/api/dialogs/D1/requests/2/retry', {}, 'retry of seq 2 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING'],
      [() => a.retry('D1', 2, 'drop_response'), 'POST', '/api/dialogs/D1/requests/2/retry', { fault: 'drop_response' }, 'retry of seq 2 · reply lost · B processed it · retry it to get the answer · task PROCESSING'],
      [() => a.complete('D1'), 'POST', '/api/dialogs/D1/complete', {}, 'task completed → COMMITTED'],
      [() => a.abort('D1', 'aborted by operator'), 'POST', '/api/dialogs/D1/fail', { reason: 'aborted by operator' }, 'task aborted by the operator → FAILED'],
      [() => a.restart('A'), 'POST', '/api/adapters/A/restart', {}, 'whole backend process restarted from the SQLite file (Adapter A requested) · 1 unfinished task reloaded'],
      [() => a.restart('B'), 'POST', '/api/adapters/B/restart', {}, 'whole backend process restarted from the SQLite file (Adapter B requested) · 1 unfinished task reloaded'],
    ];
    for (const [call, method, path, body, message] of cases) {
      const mark = server.mutations().length;
      let out;
      await act(async () => { out = await call(); });
      const made = server.mutations().slice(mark);
      equal(made.map((c) => [c.method, c.path, c.body]), [[method, path, body]], `exactly one ${method} ${path}`);
      equal([out.ok, out.message], [true, message], `result line for ${path}`);
    }
    // restart answer keeps recovered next_seq / pending_seqs for the panel
    const r = await a.restart('A');
    equal(r.result.recovered[0], { dialog_id: 'D1', task_id: 'T1', state: 'PROCESSING', next_seq: 4, pending_seqs: [3] }, 'recovered rows passed through');
    check(hook.read().logs.some((l) => l.origin === 'dashboard' && l.msg.startsWith('manual send ·')), 'manual outcome noted in the feed');
  } finally {
    await hook.unmount();
  }
});

await test('actions: RUNTIME_BUSY and PENDING_REQUESTS are user text, never a throw', async () => {
  const hook = await loaded();
  try {
    server.on('POST /api/dialogs/D1/requests', () => apiError(409, 'RUNTIME_BUSY', 'Runtime is busy'));
    server.on('POST /api/dialogs/D1/complete', () => apiError(409, 'PENDING_REQUESTS', 'pending', { pending_seqs: [2] }));
    let busy;
    let pending;
    await act(async () => { busy = await hook.read().actions.send('D1', ''); });
    await act(async () => { pending = await hook.read().actions.complete('D1'); });
    equal([busy.ok, busy.code, busy.message], [false, 'RUNTIME_BUSY', 'The backend is busy (a demo or another action is running) — try again in a moment.'], 'RUNTIME_BUSY text');
    equal([pending.ok, pending.code, pending.message], [false, 'PENDING_REQUESTS', 'Cannot complete yet — seq 2 has no answer. Retry seq 2 first.'], 'PENDING_REQUESTS text');
    check(hook.read().logs.some((l) => l.msg === 'manual complete failed · Cannot complete yet — seq 2 has no answer. Retry seq 2 first.'), 'failure noted in the feed');
    equal(server.mutations().length, 2, 'no automatic retry of the failed calls');
    equal(hook.read().busy, false, 'busy released after failures');
  } finally {
    await hook.unmount();
  }
});

await test('actions: a second action while one is in flight is refused locally (no API call)', async () => {
  const hook = await loaded();
  try {
    let release;
    server.on('POST /api/dialogs/D1/complete', () => new Promise((resolve) => { release = resolve; }));
    let first;
    await act(async () => { first = hook.read().actions.complete('D1'); });
    await waitFor(() => hook.read().busy === true, 'busy while in flight');
    const second = await hook.read().actions.send('D1', '');
    equal([second.ok, second.code], [false, 'LOCAL_BUSY'], 'refused locally');
    equal(server.mutations().map((c) => c.path), ['/api/dialogs/D1/complete'], 'no second call');
    await act(async () => { release({ status: 200, json: { dialog: { dialog_id: 'D1', task_id: 'T1', state: 'COMMITTED' } } }); await first; });
    await waitFor(() => hook.read().busy === false, 'busy released');
  } finally {
    await hook.unmount();
  }
});

await test('unmount: all poll timers stopped; an in-flight poll does not reschedule', async () => {
  const hook = await loaded();
  let release;
  server.on('GET /api/state', () => new Promise((resolve) => { release = resolve; }));
  server.emit('request_sent', { dialog_id: 'D1', task_id: 'T1', seq: 2 });
  await waitFor(() => typeof release === 'function', 'state request in flight');
  server.handlers.delete('GET /api/state');
  const errorsBefore = consoleErrors.length;
  await hook.unmount();
  const mark = server.calls.length;
  // The in-flight /api/state answers only after unmount.
  await act(async () => { release({ status: 200, json: server.stateBody() }); });
  await wait(150);
  equal(server.calls.length - mark, 0, 'no requests after unmount');
  equal(loopTimers.size, 0, `no poll timers left (${loopTimers.size})`);
  equal(consoleErrors.slice(errorsBefore), [], 'no React warnings after unmount');
});

// ---------------------------------------------------------------------------
// Components: ManualControls rules (D1/D2) and engine selection (sim vs backend)
// ---------------------------------------------------------------------------

async function bundle(source, define = {}) {
  const { build } = await import('esbuild');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const cacheDir = join(process.cwd(), 'node_modules', '.cache', 'nighthawks-backend-engine');
  await mkdir(cacheDir, { recursive: true });
  const name = `entry-${Math.random().toString(36).slice(2, 8)}`;
  const entryFile = join(cacheDir, `${name}.jsx`);
  const outFile = join(cacheDir, `${name}.mjs`);
  await writeFile(entryFile, source, 'utf8');
  const out = await build({
    entryPoints: [entryFile], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    loader: { '.js': 'jsx' }, external: ['react', 'react-dom', 'react-dom/client', 'lucide-react'], logLevel: 'silent', define,
  });
  await writeFile(outFile, out.outputFiles[0].text, 'utf8');
  return (await import(pathToFileURL(outFile).href)).default;
}

async function mountComponent(Component, props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (p) => act(async () => { root.render(h(Component, p)); });
  await render(props);
  return {
    container,
    rerender: render,
    button: (re) => [...container.querySelectorAll('button')].find((b) => re.test(b.textContent)),
    click: (el) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const src = join(process.cwd(), 'src').replaceAll('\\', '/');
const ManualControls = await bundle(`export { default } from ${JSON.stringify(`${src}/components/ManualControls.jsx`)};`);

const view = (id, state, ledger, pendingSeqs = []) => ({
  id, taskId: `task-${id}`, state, settled: TERMINAL.has(state), nextSeq: ledger.length + 1, pendingSeqs,
  ledger: ledger.map(([seq, backendStatus]) => ({ seq, backendStatus, status: 'applied' })),
});

function fakeActions(log) {
  const ok = (name, extra = {}) => (...args) => { log.push([name, ...args]); return Promise.resolve({ ok: true, message: `${name} done`, result: extra }); };
  return {
    createTask: ok('createTask', { dialog: { dialog_id: 'NEW' } }),
    send: ok('send'),
    retry: ok('retry'),
    complete: ok('complete'),
    abort: ok('abort'),
    restart: ok('restart', { recovered: [{ dialog_id: 'D1', task_id: 'T1', state: 'PROCESSING', next_seq: 4, pending_seqs: [3] }] }),
  };
}

await test('ManualControls: nothing selected → send/complete/abort/retry disabled with a hint', async () => {
  const ui = await mountComponent(ManualControls, { actions: fakeActions([]), dialogs: [], selectedId: '', onSelect: () => {}, busy: false, connected: true });
  try {
    for (const re of [/^Send seq/, /^Complete task/, /^Abort task/, /^Retry seq/, /^Send duplicate/]) check(ui.button(re)?.disabled === true, `${re} disabled`);
    check(ui.button(/^New task/).disabled === false, 'New task enabled');
    check(/Select a task in the Tasks list/.test(ui.container.textContent), 'hint shown');
  } finally {
    await ui.unmount();
  }
});

await test('ManualControls: finished task → send/complete/abort disabled, retry + duplicate still allowed', async () => {
  const dialogs = [view('D2', 'COMMITTED', [[1, 'acked'], [2, 'acked']])];
  const log = [];
  const ui = await mountComponent(ManualControls, { actions: fakeActions(log), dialogs, selectedId: 'D2', onSelect: () => {}, busy: false, connected: true });
  try {
    for (const re of [/^Send seq/, /^Complete task/, /^Abort task/]) check(ui.button(re).disabled === true, `${re} disabled`);
    check(ui.button(/^Retry seq/).disabled === false, 'retry enabled on a finished task');
    check(ui.button(/^Send duplicate/).disabled === false, 'duplicate enabled on a finished task');
    check(/This task is finished/.test(ui.container.textContent), 'finished hint');
    await ui.click(ui.button(/^Retry seq/));
    equal(log, [['retry', 'D2', 2, '']], 'retry of the newest seq');
  } finally {
    await ui.unmount();
  }
});

await test('ManualControls: retry defaults to the unanswered seq; duplicate targets the last ACKED seq', async () => {
  const dialogs = [view('D1', 'PROCESSING', [[1, 'acked'], [2, 'acked'], [3, 'pending_unprocessed'], [4, 'processed_unacked']], [3, 4])];
  const log = [];
  const ui = await mountComponent(ManualControls, { actions: fakeActions(log), dialogs, selectedId: 'D1', onSelect: () => {}, busy: false, connected: true });
  try {
    equal(ui.button(/^Retry seq/).textContent, 'Retry seq 4', 'newest unanswered seq first');
    equal(ui.button(/^Send duplicate/).textContent, 'Send duplicate of seq 2', 'last acked seq');
    await ui.click(ui.button(/^Send duplicate/));
    await ui.click(ui.button(/^Send seq/));
    equal(log, [['retry', 'D1', 2, ''], ['send', 'D1', '']], 'duplicate = retry(last acked), send with no fault');
    check(/send done/.test(ui.container.textContent), 'one-line result shown');
  } finally {
    await ui.unmount();
  }
});

await test('ManualControls: busy or offline disables every control, retry included', async () => {
  const dialogs = [view('D2', 'COMMITTED', [[1, 'acked']])];
  for (const [busy, connected, hint] of [[true, true, /Busy — a demo/], [false, false, /not reachable/]]) {
    const ui = await mountComponent(ManualControls, { actions: fakeActions([]), dialogs, selectedId: 'D2', onSelect: () => {}, busy, connected });
    try {
      const enabled = [...ui.container.querySelectorAll('button')].filter((b) => !b.disabled).map((b) => b.textContent);
      equal(enabled, [], `all buttons disabled (busy=${busy}, connected=${connected})`);
      check(hint.test(ui.container.textContent), `hint ${hint}`);
    } finally {
      await ui.unmount();
    }
  }
});

await test('ManualControls: restart shows recovered next_seq and pending seqs', async () => {
  const log = [];
  const ui = await mountComponent(ManualControls, { actions: fakeActions(log), dialogs: [], selectedId: '', onSelect: () => {}, busy: false, connected: true });
  try {
    await ui.click(ui.button(/^Restart Adapter A/));
    equal(log, [['restart', 'A']], 'restart A');
    check(ui.container.textContent.includes('D1 · T1 · PROCESSING · next_seq 4 · no answer yet: [3]'), 'recovered row rendered');
    check(/restarts the whole backend process/.test(ui.container.textContent), 'honest restart label');
  } finally {
    await ui.unmount();
  }
});

await test('engine selection: VITE_ENGINE=sim renders the old controls and makes no /api calls', async () => {
  server = createFakeBackend();
  const App = await bundle(`export { default } from ${JSON.stringify(`${src}/App.jsx`)};`, { 'import.meta.env': JSON.stringify({ VITE_ENGINE: 'sim' }) });
  const ui = await mountComponent(App, {});
  try {
    await wait(100);
    const text = ui.container.textContent;
    check(text.includes('Or try it yourself'), 'old sim controls');
    check(!text.includes('Try it yourself — on the live backend'), 'no ManualControls');
    equal(server.calls.length, 0, 'no fetch calls in sim mode');
  } finally {
    await ui.unmount();
  }
});

await test('engine selection: VITE_ENGINE=backend renders ManualControls instead', async () => {
  server = createFakeBackend();
  server.addDialog('D1', 'T1', 'PROCESSING', [{ seq: 1, status: 'acked', attempts: 1 }]);
  const App = await bundle(`export { default } from ${JSON.stringify(`${src}/App.jsx`)};`, { 'import.meta.env': JSON.stringify({ VITE_ENGINE: 'backend' }) });
  const ui = await mountComponent(App, {});
  try {
    await waitFor(() => server.callsTo('GET', '/api/state').length > 0, 'backend polled');
    const text = ui.container.textContent;
    check(text.includes('Try it yourself — on the live backend'), 'ManualControls rendered');
    check(!text.includes('Or try it yourself'), 'old sim controls hidden');
  } finally {
    await ui.unmount();
  }
});

const { rm } = await import('node:fs/promises');
await rm(join(process.cwd(), 'node_modules', '.cache', 'nighthawks-backend-engine'), { recursive: true, force: true });

console.error = realConsoleError;
const unexpected = consoleErrors.filter((m) => !/not wrapped in act/.test(m));
if (unexpected.length) console.log(`\nconsole.error output:\n  ${unexpected.slice(0, 5).join('\n  ')}`);

const failed = results.filter((r) => !r).length;
console.log(`\n${failed ? RED : GREEN}${results.length - failed}/${results.length} checks passed${RESET}\n`);
process.exit(failed ? 1 : 0);
