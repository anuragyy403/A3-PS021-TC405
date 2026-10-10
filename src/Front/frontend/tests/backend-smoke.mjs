/**
 * Smoke test of src/api/client.js against a RUNNING backend (not part of npm test).
 *
 *   BACKEND_URL=http://localhost:3001 node tests/backend-smoke.mjs
 *
 * Skips with a message if the backend is unreachable.  Creates dialogs and runs
 * a scenario on that backend (no reset).
 */
import assert from 'node:assert/strict';
import * as api from '../src/api/client.js';
import { mapEventToLog, mapScenarioResult, mapState } from '../src/api/mappers.js';

const base = process.env.BACKEND_URL ?? 'http://localhost:3001';
api.setBaseUrl(base);

try {
  await api.getHealth();
} catch (error) {
  console.log(`SKIP  backend unreachable at ${base} (${error.code ?? error.message})`);
  process.exit(0);
}

const steps = [];
const step = async (label, fn) => {
  await fn();
  steps.push(label);
  console.log(`PASS  ${label}`);
};

await step('state maps', async () => {
  const mapped = mapState(await api.getState());
  assert.ok(Array.isArray(mapped.dialogs));
  assert.equal(typeof mapped.metrics.packets, 'number');
});

let dialogId;
await step('create → send (drop_response) → retry duplicate → complete', async () => {
  dialogId = (await api.createDialog('task-smoke')).dialog.dialog_id;
  const lost = await api.sendRequest(dialogId, { op: 'smoke' }, 'drop_response');
  assert.equal(lost.delivery, 'response_dropped');
  const retry = await api.retryRequest(dialogId, 1);
  assert.equal(retry.outcome, 'duplicate');
  assert.equal((await api.completeDialog(dialogId)).dialog.state, 'COMMITTED');
  assert.equal((await api.getDialog(dialogId)).ledger[0].status, 'acked');
});

await step('typed errors: 409 DIALOG_TERMINAL, 404 DIALOG_NOT_FOUND, 400 VALIDATION_ERROR', async () => {
  await assert.rejects(api.sendRequest(dialogId, {}), (e) => e.name === 'ApiClientError' && e.status === 409 && e.code === 'DIALOG_TERMINAL');
  await assert.rejects(api.getDialog('dlg-nope'), (e) => e.status === 404 && e.code === 'DIALOG_NOT_FOUND');
  await assert.rejects(api.createDialog(''), (e) => e.status === 400 && e.code === 'VALIDATION_ERROR' && Array.isArray(e.details));
});

await step('fail + restart', async () => {
  const other = (await api.createDialog('task-smoke-2')).dialog.dialog_id;
  assert.equal((await api.failDialog(other, 'smoke')).dialog.state, 'FAILED');
  const restart = await api.restartAdapter('B');
  assert.equal(restart.scope, 'process');
});

await step('scenario run + events + list', async () => {
  const result = await api.runScenario(3, { step_delay_ms: 0 });
  assert.equal(mapScenarioResult(result).result.status, 'passed');
  const page = await api.getEvents(result.events.from - 1, 500);
  assert.ok(page.events.some((e) => e.type === 'scenario_finished'));
  assert.ok(page.events.every((e) => mapEventToLog(e) === null || typeof mapEventToLog(e).msg === 'string'));
  const list = await api.listScenarios();
  assert.equal(list.scenarios[2].last_result.run_id, result.run_id);
  assert.ok(Array.isArray((await api.listDialogs({ state: 'COMMITTED', limit: 5 })).dialogs));
});

await step('NETWORK error code when nothing listens', async () => {
  api.setBaseUrl('http://127.0.0.1:1');
  await assert.rejects(api.getState(), (e) => e.code === 'NETWORK' && e.status === 0);
  api.setBaseUrl(base);
});

console.log(`\n${steps.length} smoke steps passed against ${base}`);
