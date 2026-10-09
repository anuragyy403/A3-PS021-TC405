/**
 * npm run e2e  [-- --headed | any other Playwright CLI argument]
 *
 * Wraps `playwright test` so every run also proves it cleaned up after itself:
 *   1. refuses to start if :3101 or :5199 is already taken;
 *   2. runs the suite (Vite via Playwright webServer, backend via the fixture);
 *   3. afterwards checks both ports are free and that no node/esbuild process
 *      started during the run (tsx, vite, esbuild) is still alive — any such
 *      orphan is listed, killed, and the run is marked failed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_PORT, killTree, portInUse } from '../support/backend.js';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_PORT = 5199;
const PORTS = [BACKEND_PORT, FRONTEND_PORT];
const WATCHED = /^(node|esbuild)(\.exe)?$/i;
const OURS = /nighthawks-e2e|vite[\\/]bin[\\/]vite\.js|Nighthawks[\\/]Front[\\/]frontend[\\/]node_modules[\\/]@esbuild/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** node/esbuild processes: Map pid → command line (Windows via CIM; elsewhere via ps). */
function processes() {
  const map = new Map();
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='esbuild.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }"],
      { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        const [pid, name, cmd = ''] = line.split('\t');
        if (pid && WATCHED.test(name ?? '')) map.set(Number(pid), cmd);
      }
    } else {
      const out = execFileSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (m && WATCHED.test(path.basename(m[2]))) map.set(Number(m[1]), m[3]);
      }
    }
  } catch (error) {
    console.warn(`[e2e] could not list processes: ${error.message}`);
  }
  return map;
}

for (const port of PORTS) {
  if (await portInUse(port)) {
    console.error(`[e2e] port ${port} is already in use — stop that process first (see e2e/README.md).`);
    process.exit(2);
  }
}

const before = processes();
const started = Date.now();
const cli = path.join(E2E_DIR, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [cli, 'test', ...process.argv.slice(2)], { cwd: E2E_DIR, stdio: 'inherit' });
const code = await new Promise((resolve) => child.once('exit', (c) => resolve(c ?? 1)));
const seconds = ((Date.now() - started) / 1000).toFixed(1);

// Ports must be released (give the OS a moment after the webServer is killed).
const busy = [];
for (const port of PORTS) {
  const until = Date.now() + 10_000;
  while ((await portInUse(port)) && Date.now() < until) await sleep(200);
  if (await portInUse(port)) busy.push(port);
}

// Orphans: processes that did not exist before the run and look like ours.
await sleep(500);
const orphans = [...processes()].filter(([pid, cmd]) => !before.has(pid) && pid !== process.pid && OURS.test(cmd));
for (const [pid] of orphans) killTree(pid);

let summary = '';
try {
  const report = JSON.parse(readFileSync(path.join(E2E_DIR, 'test-results', 'results.json'), 'utf8'));
  const s = report.stats ?? {};
  summary = ` · ${s.expected ?? 0} passed, ${s.unexpected ?? 0} failed, ${s.flaky ?? 0} flaky, ${s.skipped ?? 0} skipped`;
} catch {
  // no JSON report (e.g. --reporter override)
}

console.log(`\n[e2e] playwright exit ${code} in ${seconds}s${summary}`);
console.log(`[e2e] ports ${PORTS.join('/')}: ${busy.length ? `STILL IN USE: ${busy.join(', ')}` : 'free'}`);
console.log(`[e2e] orphaned processes: ${orphans.length ? orphans.map(([pid, cmd]) => `\n  ${pid} ${cmd}`).join('') + '\n  (killed)' : 'none'}`);

process.exit(code !== 0 ? code : busy.length || orphans.length ? 3 : 0);
