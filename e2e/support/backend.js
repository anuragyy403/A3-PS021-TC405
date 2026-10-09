/**
 * Owns the backend OS process for the E2E run.
 *
 * The backend is started from source as ONE node process
 * (`node --import tsx src/server.ts`, no watch mode), on a dedicated port and a
 * fresh temp database file, so it never touches backend/dialogs.db or a dev
 * server. Tests can stop it (a hard kill, like a crash) and start it again on
 * the SAME database file, which is a real OS-process restart.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
export const BACKEND_PORT = 3101;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
/** Marker argument so the run script can recognise (and report) our process. */
export const BACKEND_MARKER = 'nighthawks-e2e-backend';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True if something accepts TCP connections on the port (IPv4 or IPv6 localhost). */
export async function portInUse(port) {
  const tryHost = (host) => new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
  return (await tryHost('127.0.0.1')) || (await tryHost('::1'));
}

/** Kill a process and all of its children (Windows needs taskkill /T). */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}

export class BackendProcess {
  constructor() {
    const stamp = `${Date.now()}-${process.pid}`;
    this.dbPath = path.join(os.tmpdir(), `nighthawks-e2e-${stamp}.db`);
    this.logPath = path.join(REPO_ROOT, 'e2e', 'test-results', `backend-${stamp}.log`);
    this.child = null;
    this.starts = 0;
  }

  get running() {
    return this.child !== null;
  }

  async start() {
    if (this.child) return;
    if (await portInUse(BACKEND_PORT)) {
      throw new Error(`port ${BACKEND_PORT} is already in use — stop whatever listens there (see e2e/README.md)`);
    }
    mkdirSync(path.dirname(this.logPath), { recursive: true });
    const log = createWriteStream(this.logPath, { flags: 'a' });
    this.starts += 1;
    log.write(`\n--- start #${this.starts} ${new Date().toISOString()} db=${this.dbPath}\n`);

    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', BACKEND_MARKER], {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        PORT: String(BACKEND_PORT),
        DB_PATH: this.dbPath,
        NODE_ENV: 'development',      // reset allowed (demo-only endpoint)
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    this.child = child;
    child.once('exit', () => { if (this.child === child) this.child = null; });

    await this.waitHealthy();
  }

  async waitHealthy(timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
      if (!this.child) throw new Error(`backend exited during startup — see ${this.logPath}`);
      try {
        const res = await fetch(`${BACKEND_URL}/health`);
        if (res.ok && (await res.json()).status === 'ok') return;
        last = `HTTP ${res.status}`;
      } catch (error) {
        last = error.message;
      }
      await sleep(200);
    }
    throw new Error(`backend not healthy after ${timeoutMs} ms (${last}) — see ${this.logPath}`);
  }

  /** Hard stop (like a crash): kill the process tree, wait until the port is free. */
  async stop() {
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killTree(child.pid);
    await Promise.race([exited, sleep(10_000)]);
    this.child = null;
    const until = Date.now() + 10_000;
    while (await portInUse(BACKEND_PORT)) {
      if (Date.now() > until) throw new Error(`port ${BACKEND_PORT} still in use after stopping the backend`);
      await sleep(100);
    }
  }

  /** Stop and remove the temp database file. */
  async dispose() {
    await this.stop();
    rmSync(this.dbPath, { force: true });
  }
}
