#!/usr/bin/env node
/**
 * Demo launcher (PS-021 Phase 10).  Plain Node, no dependencies.
 *
 *   node scripts/demo.mjs                  backend :3001 (fresh .demo/demo.db) + dashboard :5173
 *   node scripts/demo.mjs --keep-db        reuse the existing .demo/demo.db
 *   node scripts/demo.mjs --pace 600       scenario step delay in ms (0–1000, default 900)
 *   node scripts/demo.mjs --backend-only   only the backend (for the real process-restart segment)
 *   node scripts/demo.mjs --frontend-only  only the dashboard (backend started separately)
 *
 * Stop with Ctrl+C (or type q + Enter): both process trees are killed
 * (Windows: taskkill /T) and the ports are checked free.  The launcher refuses
 * to start when a port it needs is busy and names the process — it never kills
 * anything it did not start.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, portInUse } from '../e2e/support/backend.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const FRONTEND_DIR = path.join(ROOT, 'Front', 'frontend');
const DEMO_DIR = path.join(ROOT, '.demo');
const DB_PATH = path.join(DEMO_DIR, 'demo.db');
const BACKEND_PORT = 3001;
const FRONTEND_PORT = 5173;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line = '') => process.stdout.write(`${line}\n`);

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
if (flag('--help') || flag('-h')) {
  say(fileURLToPath(import.meta.url));
  say('Usage: node scripts/demo.mjs [--keep-db] [--pace <ms>] [--backend-only | --frontend-only]');
  process.exit(0);
}
const keepDb = flag('--keep-db');
const backendOnly = flag('--backend-only');
const frontendOnly = flag('--frontend-only');
if (backendOnly && frontendOnly) {
  say('[demo] choose at most one of --backend-only and --frontend-only');
  process.exit(2);
}
let pace = 900;
const paceAt = argv.indexOf('--pace');
if (paceAt !== -1) {
  pace = Number(argv[paceAt + 1]);
  if (!Number.isInteger(pace) || pace < 0 || pace > 1000) {
    say('[demo] --pace must be an integer between 0 and 1000 (ms)');
    process.exit(2);
  }
}
const known = new Set(['--keep-db', '--backend-only', '--frontend-only', '--pace', String(argv[paceAt + 1])]);
const unknown = argv.filter((a) => !known.has(a));
if (unknown.length) {
  say(`[demo] unknown argument(s): ${unknown.join(' ')}  (see --help)`);
  process.exit(2);
}
const wantBackend = !frontendOnly;
const wantFrontend = !backendOnly;

// ---------------------------------------------------------------- who holds a port
function describePortOwner(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      const line = out.split(/\r?\n/).find((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l.trim().split(/\s+/)[1] + ' '));
      const pid = line?.trim().split(/\s+/).pop();
      if (!pid) return 'an unknown process';
      let what = '';
      try {
        what = execFileSync('powershell', ['-NoProfile', '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; "$($p.Name) $($p.CommandLine)"`], { encoding: 'utf8' }).trim();
      } catch { /* name is optional */ }
      return `PID ${pid}${what ? ` (${what.slice(0, 140)})` : ''}`;
    }
    const pid = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0];
    return pid ? `PID ${pid}` : 'an unknown process';
  } catch {
    return 'an unknown process';
  }
}

const needed = [...(wantBackend ? [BACKEND_PORT] : []), ...(wantFrontend ? [FRONTEND_PORT] : [])];
for (const port of needed) {
  if (await portInUse(port)) {
    say(`[demo] port ${port} is already in use by ${describePortOwner(port)}.`);
    say('[demo] Stop that process first (it may be another dev server). The launcher never kills processes it did not start.');
    process.exit(2);
  }
}

// ---------------------------------------------------------------- children
const children = new Map();   // name → ChildProcess
let shuttingDown = false;

function pipeWithPrefix(stream, prefix) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) say(`${prefix} ${line}`);
  });
}

function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  pipeWithPrefix(child.stdout, `[${name}]`);
  pipeWithPrefix(child.stderr, `[${name}]`);
  children.set(name, child);
  child.once('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    say(`[demo] ${name} exited (${signal ?? `code ${code}`}).`);
    if (name === 'backend' && wantFrontend) {
      say('[demo] The dashboard will show "Disconnected". Restart the backend with: node scripts/demo.mjs --backend-only --keep-db');
    }
    if (children.size === 0) shutdown(1);
  });
  return child;
}

async function waitFor(url, check, label, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (await check(res)) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`${label} did not come up within ${timeoutMs / 1000}s`);
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  say('\n[demo] stopping…');
  for (const child of children.values()) killTree(child.pid);
  const until = Date.now() + 10_000;
  for (const port of needed) {
    while ((await portInUse(port)) && Date.now() < until) await sleep(150);
  }
  const busy = [];
  for (const port of needed) if (await portInUse(port)) busy.push(port);
  say(busy.length ? `[demo] WARNING: still in use: ${busy.join(', ')}` : `[demo] stopped; port(s) ${needed.join(' and ')} free.`);
  process.exit(busy.length ? 1 : code);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  try { process.on(signal, () => shutdown(0)); } catch { /* signal not supported here */ }
}
// Ctrl+C / q from the keyboard (raw mode keeps Ctrl+C away from the children too).
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    const k = key.toString();
    if (k === '\u0003' || k.toLowerCase() === 'q') shutdown(0);
  });
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (text) => { if (/^\s*q\s*$/im.test(text)) shutdown(0); });
}

// ---------------------------------------------------------------- go
try {
  if (wantBackend) {
    mkdirSync(DEMO_DIR, { recursive: true });
    if (!keepDb) rmSync(DB_PATH, { force: true });
    const reused = keepDb && existsSync(DB_PATH);
    say(`[demo] backend: ${reused ? 'reusing' : 'fresh'} database ${path.relative(ROOT, DB_PATH)}`);
    start('backend', ['--import', 'tsx', 'src/server.ts', 'nighthawks-demo-backend'], BACKEND_DIR, {
      PORT: String(BACKEND_PORT), DB_PATH, NODE_ENV: 'development', LOG_LEVEL: 'warn',
    });
    await waitFor(`${BACKEND_URL}/health`, async (res) => res.ok && (await res.json()).status === 'ok', 'backend');
    const state = await (await fetch(`${BACKEND_URL}/api/state`)).json();
    const open = state.dialogs.filter((d) => !d.terminal).length;
    say(`[demo] backend ready on ${BACKEND_URL} — ${state.metrics.dialogs_total} task(s) in the database, ${open} unfinished`);
  }
  if (wantFrontend) {
    start('vite', ['node_modules/vite/bin/vite.js', '--port', String(FRONTEND_PORT), '--strictPort'], FRONTEND_DIR, {
      VITE_BACKEND_URL: BACKEND_URL, VITE_SCENARIO_STEP_DELAY_MS: String(pace),
    });
    await waitFor(FRONTEND_URL, async (res) => res.ok, 'dashboard');
  }
} catch (error) {
  say(`[demo] ${error.message}`);
  await shutdown(1);
}

say('');
say('  Nighthawks PS-021 demo is running');
if (wantFrontend) say(`  Dashboard  ${FRONTEND_URL}   (scenario pace ${pace} ms per step)`);
if (wantBackend) say(`  Backend    ${BACKEND_URL}   (database ${path.relative(ROOT, DB_PATH)})`);
if (frontendOnly) say(`  Backend expected at ${BACKEND_URL} — start it with: node scripts/demo.mjs --backend-only`);
say('  Trace      node scripts/trace.mjs        (second terminal, beside the browser)');
say('  Script     docs/DEMO_SCRIPT.md');
say('  Stop       Ctrl+C (or q + Enter) — stops what this launcher started and frees its ports');
say('');
