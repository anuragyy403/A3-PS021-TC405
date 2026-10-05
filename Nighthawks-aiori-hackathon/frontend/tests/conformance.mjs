/**
 * Headless PS-021 conformance harness.
 *
 * Mounts the correlation engine inside a jsdom document, executes the five
 * mandatory disconnect/retry scenarios plus an adversarial replay, and asserts
 * the same invariants the console reports to the judges.
 *
 *   npm test
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
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

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { useCorrelationEngine } = await import('../src/lib/useCorrelationEngine.js');

/**
 * Node cannot execute `.jsx`, so the render tests bundle the real components
 * with esbuild (already present via Vite) and import the result from inside the
 * project, which keeps bare specifiers such as `react` resolvable against the
 * installed tree.
 *
 * `source` is written to a scratch entry file so a test can mount a chosen
 * component with fixture props.
 */
async function loadComponents(source) {
  const { build } = await import('esbuild');
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const cacheDir = join(process.cwd(), 'node_modules', '.cache', 'nighthawks-smoke');
  await mkdir(cacheDir, { recursive: true });
  const entryFile = join(cacheDir, 'entry.jsx');
  const outFile = join(cacheDir, 'entry.mjs');

  await writeFile(entryFile, source, 'utf8');

  const bundle = await build({
    entryPoints: [entryFile],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    external: ['react', 'react-dom', 'react-dom/client', 'lucide-react'],
    logLevel: 'silent',
  });

  await writeFile(outFile, bundle.outputFiles[0].text, 'utf8');
  const { pathToFileURL } = await import('node:url');
  const mod = await import(`${pathToFileURL(outFile).href}?v=${Date.now()}`);
  return { Component: mod.default, cleanup: () => rm(cacheDir, { recursive: true, force: true }) };
}

/** Mounts a component with props into a detached container and returns its text. */
async function mountAndRead(Component, props = {}) {
  const consoleErrors = [];
  const realError = console.error;
  console.error = (...args) => consoleErrors.push(args.map(String).join(' '));

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(h(Component, props));
    });
    return { text: container.textContent ?? '', errors: consoleErrors };
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    console.error = realError;
  }
}

const h = React.createElement;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` inside act() so React flushes every state update before we assert. */
async function run(fn) {
  let outcome;
  await act(async () => {
    outcome = await fn();
  });
  return outcome;
}

/** Advances real timers inside act() so timers and renders settle together. */
async function wait(ms) {
  await act(async () => {
    await sleep(ms);
  });
}

/** Mounts the engine hook and exposes its latest committed return value. */
function mountEngine() {
  const box = { current: null };
  function Harness() {
    box.current = useCorrelationEngine();
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  act(() => {
    root.render(h(Harness));
  });
  return {
    read: () => box.current,
    unmount: () => act(() => root.unmount()),
  };
}

const results = [];
const GREEN = '[32m';
const RED = '[31m';
const DIM = '[90m';
const BOLD = '[1m';
const RESET = '[0m';

function assert(label, ok, detail = '') {
  const passed = Boolean(ok);
  results.push({ label, ok: passed, detail });
  const mark = passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`${mark}  ${label}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

const harness = mountEngine();
const eng = () => harness.read();
const findDialog = (id) => eng().dialogs.find((item) => item.id === id);

console.log(`\n${BOLD}Nighthawks - PS-021 conformance harness${RESET}\n`);

/* ---------------------------------------------------------------- */
/* Render smoke - the whole component tree must mount cleanly        */
/* ---------------------------------------------------------------- */
{
  const { join } = await import('node:path');
  const src = join(process.cwd(), 'src');
  const { Component, cleanup } = await loadComponents(`
    import App from ${JSON.stringify(join(src, 'App.jsx'))};
    export default App;
  `);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const consoleErrors = [];
  const realError = console.error;
  console.error = (...args) => consoleErrors.push(args.map(String).join(' '));

  try {
    await act(async () => {
      root.render(h(Component));
    });

    const text = container.textContent ?? '';
    assert('render: component tree mounts', container.childElementCount > 0, `${container.childElementCount} root node(s)`);
    assert('render: experiment identity visible', text.includes('PS-021') && text.includes('AIORI-3'), 'PS-021 / AIORI-3');

    assert(
      'render: four executive metrics visible',
      ['Connection Status', 'Total Tasks Processed', 'Duplicates Blocked', 'Recovery Success Rate'].every((label) => text.includes(label)),
      '4 metrics',
    );
    assert(
      'render: pipeline shows both agents and the channel',
      ['Sender Agent', 'Network Channel', 'Receiver Agent', 'Saved State'].every((label) => text.includes(label)),
      '4 pipeline nodes',
    );
    assert(
      'render: all five demonstrations present',
      [
        'Normal Transmission',
        'Out-of-Order Packets',
        'System Crash & Auto-Recovery',
        'Duplicate Request Guard',
        'Missing Packet Recovery',
      ].every((title) => text.includes(title)),
      '5 scenarios',
    );
    assert(
      'render: every panel is titled in plain language',
      ['Live message pipeline', 'Demonstrations', 'Tasks', 'What is happening'].every((label) => text.includes(label)),
      '4 panels',
    );
    assert('render: recovery rate defaults to 100%', text.includes('100%'), '100%');
    assert(
      'render: no internal identifiers leak into the empty state',
      !/WAITING_ACK|COMMITTED|RECOVERED/.test(text),
      'no raw lifecycle names',
    );
    assert(
      'render: no React warnings or errors',
      consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors[0].slice(0, 160) : 'clean console',
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    console.error = realError;
    await cleanup();
  }
}

/* ---------------------------------------------------------------- */
/* Scenario 1 - normal asynchronous flow                            */
/* ---------------------------------------------------------------- */
{
  const wireBefore = eng().wire.length;
  const outcome = await run(() => eng().runScenario(1));
  const dialog = findDialog(outcome.dialogId);
  const passedCount = outcome.assertions.filter((row) => row.ok).length;
  const wire = eng().wire.slice(wireBefore);
  assert('S1 scenario reports pass', outcome.passed, `${passedCount}/${outcome.assertions.length} assertions`);
  assert('S1 terminal state COMMITTED', dialog?.state === 'COMMITTED', dialog?.state);
  assert('S1 exactly 3 side-effects', dialog?.sideEffects === 3, String(dialog?.sideEffects));
  assert('S1 applied order 1,2,3', dialog?.appliedOrder.join(',') === '1,2,3', dialog?.appliedOrder.join('>'));
  assert('S1 no duplicate suppression', dialog?.suppressed === 0, String(dialog?.suppressed));
  assert('S1 wire feed emitted packets', wire.filter((event) => event.phase === 'sent').length >= 3, `${wire.length} events`);
  assert('S1 wire feed reached a terminal phase', wire.some((event) => event.phase === 'done'), wire.map((event) => event.phase).join(','));
  assert('S1 wire events are strictly ordered', wire.every((event, index) => index === 0 || event.id > wire[index - 1].id), 'monotonic ids');
}

/* ---------------------------------------------------------------- */
/* Scenario 2 - out-of-order reordering                             */
/* ---------------------------------------------------------------- */
{
  const outcome = await run(() => eng().runScenario(2));
  const dialog = findDialog(outcome.dialogId);
  const passedCount = outcome.assertions.filter((row) => row.ok).length;
  assert('S2 scenario reports pass', outcome.passed, `${passedCount}/${outcome.assertions.length} assertions`);
  assert('S2 applied order 1,2,3 despite 3,1,2 on the wire', dialog?.appliedOrder.join(',') === '1,2,3', dialog?.appliedOrder.join('>'));
  assert('S2 reorder buffer drained', dialog?.buffered.length === 0, JSON.stringify(dialog?.buffered));
  assert('S2 no duplicates', dialog?.suppressed === 0, String(dialog?.suppressed));
}

/* ---------------------------------------------------------------- */
/* Scenario 3 - mid-task drop + durable recovery                     */
/* ---------------------------------------------------------------- */
{
  const recoveryBefore = eng().metrics.recoveryAttempted;
  const outcome = await run(() => eng().runScenario(3));
  const dialog = findDialog(outcome.dialogId);
  const passedCount = outcome.assertions.filter((row) => row.ok).length;
  assert('S3 scenario reports pass', outcome.passed, `${passedCount}/${outcome.assertions.length} assertions`);
  assert('S3 terminal state RECOVERED', dialog?.state === 'RECOVERED', dialog?.state);
  assert('S3 dialog was rehydrated from the durable store', dialog?.restored === true, String(dialog?.restored));
  assert('S3 task identity stable', /^task-[0-9a-f]{8}$/.test(dialog?.taskId ?? ''), dialog?.taskId);
  assert('S3 exactly 3 side-effects (no double-apply)', dialog?.sideEffects === 3, String(dialog?.sideEffects));
  assert('S3 applied order 1,2,3', dialog?.appliedOrder.join(',') === '1,2,3', dialog?.appliedOrder.join('>'));
  assert('S3 recovery counted in metrics', eng().metrics.recoveryAttempted > recoveryBefore, `${recoveryBefore} -> ${eng().metrics.recoveryAttempted}`);
  assert(
    'S3 adapter + bridge back online after restart',
    eng().nodes.adapterA.status === 'online' && eng().nodes.bridge.status === 'online',
    `${eng().nodes.adapterA.status}/${eng().nodes.bridge.status}`,
  );
}

/* ---------------------------------------------------------------- */
/* Scenario 4 - request deduplication                               */
/* ---------------------------------------------------------------- */
{
  const dedupBefore = eng().metrics.dedup;
  const outcome = await run(() => eng().runScenario(4));
  const dialog = findDialog(outcome.dialogId);
  const passedCount = outcome.assertions.filter((row) => row.ok).length;
  assert('S4 scenario reports pass', outcome.passed, `${passedCount}/${outcome.assertions.length} assertions`);
  assert('S4 side-effect ledger holds exactly 1', dialog?.sideEffects === 1, String(dialog?.sideEffects));
  assert('S4 all 4 replays rejected', dialog?.suppressed === 4, String(dialog?.suppressed));
  assert('S4 global dedup counter advanced by 4', eng().metrics.dedup - dedupBefore === 4, String(eng().metrics.dedup - dedupBefore));
}

/* ---------------------------------------------------------------- */
/* Scenario 5 - gap detection + automated re-transmission           */
/* ---------------------------------------------------------------- */
{
  const outcome = await run(() => eng().runScenario(5));
  const dialog = findDialog(outcome.dialogId);
  const passedCount = outcome.assertions.filter((row) => row.ok).length;
  assert('S5 scenario reports pass', outcome.passed, `${passedCount}/${outcome.assertions.length} assertions`);
  assert('S5 all 4 sequences applied in order', dialog?.appliedOrder.join(',') === '1,2,3,4', dialog?.appliedOrder.join('>'));
  assert('S5 exactly 4 side-effects', dialog?.sideEffects === 4, String(dialog?.sideEffects));
  assert('S5 buffer fully drained', dialog?.buffered.length === 0, JSON.stringify(dialog?.buffered));
  const nack = eng().logs.find((entry) => entry.kind === 'recovery' && entry.msg.includes('NACK seq 2, 3'));
  assert('S5 emitted a NACK for the missing window', Boolean(nack), nack?.msg ?? 'not found');
}

/* ---------------------------------------------------------------- */
/* Adversarial - an unrecoverable gap must FAIL, not hang            */
/* ---------------------------------------------------------------- */
{
  const dialogId = 'dlg-adversarial-gap';
  await run(() =>
    eng().dispatch({ dialogId, seq: 1, protocol: 'MCP', payload: { probe: 1 }, delayMs: 0, outOfOrder: false, blackhole: false }),
  );
  // seq 2 is marked lossy before it is offered, so the bridge can never deliver it.
  await run(() =>
    eng().dispatch({ dialogId, seq: 2, protocol: 'MCP', payload: { probe: 2 }, delayMs: 0, outOfOrder: false, blackhole: true }),
  );
  await run(() =>
    eng().dispatch({ dialogId, seq: 3, protocol: 'MCP', payload: { probe: 3 }, delayMs: 0, outOfOrder: false, blackhole: false }),
  );
  await wait(4800);
  const dialog = findDialog(dialogId);
  assert('adversarial: permanently lost seq 2 drives the dialog to FAILED', dialog?.state === 'FAILED', dialog?.state);
  assert('adversarial: side-effects only for frames actually applied', dialog?.sideEffects === 1, String(dialog?.sideEffects));
  assert('adversarial: the lost frame was never applied', !dialog?.appliedOrder.includes(2), dialog?.appliedOrder.join('>'));
  await run(() => eng().clearBlackholes());
}

/* ---------------------------------------------------------------- */
/* Engine-wide invariants                                           */
/* ---------------------------------------------------------------- */
{
  const all = eng().dialogs;

  const doubleApplied = all.filter((dialog) => new Set(dialog.appliedOrder).size !== dialog.appliedOrder.length);
  assert('invariant: no sequence applied twice in any dialog', doubleApplied.length === 0, doubleApplied.map((d) => d.id).join(',') || 'none');

  const brokenLedger = all.filter((dialog) =>
    dialog.history.some((entry, index) => index > 0 && entry.from !== dialog.history[index - 1].state),
  );
  assert('invariant: transition ledger is contiguous', brokenLedger.length === 0, brokenLedger.map((d) => d.id).join(',') || 'none');

  // A successful dialog must leave nothing buffered. FAILED is allowed to keep
  // its buffer: the retained frames are the forensic record of the open gap.
  const successLeak = all.filter((dialog) => ['COMMITTED', 'RECOVERED'].includes(dialog.state) && dialog.buffered.length > 0);
  assert('invariant: no successfully settled dialog retains buffered frames', successLeak.length === 0, successLeak.map((d) => d.id).join(',') || 'none');

  const failedWithGap = all.filter((dialog) => dialog.state === 'FAILED');
  assert(
    'invariant: every FAILED dialog records the window it could not close',
    failedWithGap.every((dialog) => dialog.buffered.length > 0 || dialog.missing.length > 0),
    failedWithGap.map((d) => `${d.id}[b:${d.buffered.join('|')} m:${d.missing.join('|')}]`).join(' ') || 'none failed',
  );

  const rate = eng().metrics.recoveryRate;
  assert('invariant: recovery success rate is a sane percentage', rate === null || (rate >= 0 && rate <= 100), String(rate));
  assert(
    'invariant: dedup + side-effects never exceed packets processed',
    eng().metrics.dedup + eng().metrics.sideEffects <= eng().metrics.packets,
    `${eng().metrics.dedup} + ${eng().metrics.sideEffects} <= ${eng().metrics.packets}`,
  );
  assert('invariant: log buffer respects its 600-entry cap', eng().logs.length <= 600, String(eng().logs.length));
  assert('invariant: every scenario recorded a result', eng().scenarioResults && Object.keys(eng().scenarioResults).length === 5, Object.keys(eng().scenarioResults ?? {}).join(','));
  assert(
    'invariant: all five scenarios passed',
    Object.values(eng().scenarioResults ?? {}).every((result) => result.status === 'passed'),
    Object.entries(eng().scenarioResults ?? {})
      .map(([id, result]) => `${id}:${result.status}`)
      .join(' '),
  );
}

/* ---------------------------------------------------------------- */
/* Reset path                                                       */
/* ---------------------------------------------------------------- */
{
  await run(() => eng().resetEngine());
  assert('reset: logs cleared', eng().logs.length === 0, String(eng().logs.length));
  assert('reset: dialogs cleared', eng().dialogs.length === 0, String(eng().dialogs.length));
  assert(
    'reset: metrics zeroed',
    eng().metrics.packets === 0 && eng().metrics.dedup === 0,
    JSON.stringify({ packets: eng().metrics.packets, dedup: eng().metrics.dedup }),
  );
}

/* ---------------------------------------------------------------- */
/* Populated render - the task list and feed must cope with the      */
/* real dialog and log shapes the engine produced above.              */
/* ---------------------------------------------------------------- */
{
  await run(() => eng().runScenario(1));
  await run(() => eng().runScenario(4));
  await run(() => eng().runScenario(5));
  const fixture = eng();

  const { join } = await import('node:path');
  const src = join(process.cwd(), 'src');
  const { Component, cleanup } = await loadComponents(`
    import TaskList from ${JSON.stringify(join(src, 'components', 'TaskList.jsx'))};
    import ActivityFeed from ${JSON.stringify(join(src, 'components', 'ActivityFeed.jsx'))};

    export default function Populated({ dialogs, logs }) {
      return (
        <div>
          <TaskList dialogs={dialogs} selectedId="" onSelect={() => {}} />
          <ActivityFeed logs={logs} onClear={() => {}} />
        </div>
      );
    }
  `);

  try {
    const { text, errors } = await mountAndRead(Component, { dialogs: fixture.dialogs, logs: fixture.logs });

    assert('populated: the task list rendered every task', fixture.dialogs.every((dialog) => text.includes(dialog.id)), `${fixture.dialogs.length} tasks`);
    assert('populated: finished tasks are summarised in plain language', /of \d+ work items/.test(text), 'progress shown');
    assert('populated: the duplicate guard is called out', text.includes('duplicate') || text.includes('Duplicates'), 'duplicate count surfaced');
    assert('populated: the feed explained the run', text.includes('What is happening'), 'feed mounted');
    assert('populated: no raw lifecycle names are shown as labels', !/WAITING_ACK/.test(text), 'no internal state names');
    assert(
      'populated: no React warnings or errors',
      errors.length === 0,
      errors.length ? errors[0].slice(0, 200) : 'clean console',
    );
  } finally {
    await cleanup();
  }
}

harness.unmount();

const failed = results.filter((result) => !result.ok);
const colour = failed.length === 0 ? GREEN : RED;
console.log(`\n${colour}${results.length - failed.length}/${results.length} checks passed${RESET}\n`);
process.exit(failed.length === 0 ? 0 : 1);