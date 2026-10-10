/**
 * Captures REAL backend responses into tests/fixtures/ for tests/mappers.mjs.
 *
 *   BACKEND_URL=http://localhost:3001 node tests/capture-fixtures.mjs
 *
 * Needs a running backend (backend/: npm run dev). It resets the backend first
 * (POST /api/reset), so do not point it at a database you care about.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const base = (process.env.BACKEND_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const dir = join(process.cwd(), 'tests', 'fixtures');

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const save = (name, data) => writeFile(join(dir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');

await mkdir(dir, { recursive: true });
await call('POST', '/api/reset', { confirm: 'RESET' });

// A manual dialog left mid-flight: seq 1 acked, seq 2 processed but response lost,
// seq 3 lost before B (gives all three ledger statuses).
const { dialog } = await call('POST', '/api/dialogs', { task_id: 'task-fixture' });
const D = `/api/dialogs/${dialog.dialog_id}`;
await call('POST', `${D}/requests`, { payload: { step: 1 } });
await call('POST', `${D}/requests`, { payload: { step: 2 }, fault: 'drop_response' });
await call('POST', `${D}/requests`, { payload: { step: 3 }, fault: 'drop_request' });
await save('dialog-detail.json', await call('GET', D));

// Scenario 1 (two dialogs), Scenario 4 (restart → RECOVERED), a rejected retry, a failed dialog.
const s1 = await call('POST', '/api/scenarios/1/run', {});
const s4 = await call('POST', '/api/scenarios/4/run', {});
await save('scenario-result-1.json', s1);
await save('scenario-result-4.json', s4);

const failed = (await call('POST', '/api/dialogs', { task_id: 'task-fixture-failed' })).dialog;
const F = `/api/dialogs/${failed.dialog_id}`;
await call('POST', `${F}/requests`, { payload: { step: 1 }, fault: 'drop_request' });
await call('POST', `${F}/fail`, { reason: 'fixture abort' });
await call('POST', `${F}/requests/1/retry`, {});   // → rejected DIALOG_TERMINAL

await save('state.json', await call('GET', '/api/state'));
await save('events.json', await call('GET', '/api/events?since=0&limit=500'));
await save('scenarios.json', await call('GET', '/api/scenarios'));

console.log(`fixtures written to ${dir}`);
