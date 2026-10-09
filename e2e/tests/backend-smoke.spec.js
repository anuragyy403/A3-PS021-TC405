import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '../support/fixtures.js';
import { BACKEND_URL, REPO_ROOT } from '../support/backend.js';

/**
 * Runs Front/frontend/tests/backend-smoke.mjs (the dashboard's API client against
 * a real backend) inside the E2E run, against the E2E backend on :3101. The
 * script itself is unchanged; it already reads BACKEND_URL.
 */
test('smoke script: src/api/client.js against the E2E backend', async ({ api }) => {
  await api.reset();
  const run = spawnSync(process.execPath, ['tests/backend-smoke.mjs'], {
    cwd: path.join(REPO_ROOT, 'Front', 'frontend'),
    env: { ...process.env, BACKEND_URL },
    encoding: 'utf8',
    timeout: 60_000,
  });
  test.info().attach('backend-smoke output', { body: `${run.stdout}\n${run.stderr}`, contentType: 'text/plain' });
  expect(run.stdout).not.toContain('SKIP');
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain(`6 smoke steps passed against ${BACKEND_URL}`);
});
