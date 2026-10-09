import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { BACKEND_URL } from './support/backend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(here, '..', 'Front', 'frontend');
export const FRONTEND_PORT = 5199;

/**
 * One worker, one shared backend (support/fixtures.js starts it on :3101 with a
 * fresh temp DB); Vite is started here on :5199 and proxies /api to :3101.
 * Browser: the locally installed Microsoft Edge (no Playwright browser download).
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/artifacts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: process.env.E2E_TRACE ?? 'retain-on-failure',   // E2E_TRACE=on to keep every trace
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --port ${FRONTEND_PORT} --strictPort`,
    cwd: FRONTEND_DIR,
    url: `http://localhost:${FRONTEND_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_BACKEND_URL: BACKEND_URL },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
