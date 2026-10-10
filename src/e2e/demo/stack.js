/**
 * Boots the same isolated stack as the E2E run for the demo scripts:
 * backend :3101 (fresh temp DB, support/backend.js) + Vite :5199 proxying to it.
 * Never touches the dev ports 3001/5173 or backend/dialogs.db.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { BACKEND_URL, BackendProcess, REPO_ROOT, killTree, portInUse } from '../support/backend.js';

export const FRONTEND_PORT = 5199;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startStack({ pace = 900 } = {}) {
  if (await portInUse(FRONTEND_PORT)) throw new Error(`port ${FRONTEND_PORT} is already in use`);
  const backend = new BackendProcess();
  await backend.start();

  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(FRONTEND_PORT), '--strictPort'], {
    cwd: path.join(REPO_ROOT, 'Front', 'frontend'),
    env: { ...process.env, VITE_BACKEND_URL: BACKEND_URL, VITE_SCENARIO_STEP_DELAY_MS: String(pace) },
    stdio: 'ignore',
    windowsHide: true,
  });
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(FRONTEND_URL)).ok) break;
    } catch { /* starting */ }
    if (Date.now() > until) {
      killTree(vite.pid);
      await backend.dispose();
      throw new Error('Vite did not start');
    }
    await sleep(250);
  }

  return {
    backend,
    async stop() {
      killTree(vite.pid);
      await backend.dispose();
      const deadline = Date.now() + 10_000;
      while ((await portInUse(FRONTEND_PORT)) && Date.now() < deadline) await sleep(150);
    },
  };
}
