/**
 * Message helper tests (Phase 7b).  node tests/messages.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dialogMessage, errorMessage, outcomeMessage, restartMessage } from '../src/api/messages.js';
import { ApiClientError } from '../src/api/client.js';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

const results = [];
function test(label, fn) {
  try {
    fn();
    results.push(true);
    console.log(`${GREEN}PASS${RESET}  ${label}`);
  } catch (error) {
    results.push(false);
    console.log(`${RED}FAIL${RESET}  ${label}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}

const err = (code, extra = {}) => new ApiClientError({ status: 400, code, message: extra.message ?? code, details: extra.details });
const scenario4 = JSON.parse(await readFile(join(process.cwd(), 'tests', 'fixtures', 'scenario-result-4.json'), 'utf8'));

console.log(`\n${BOLD}Nighthawks - message helper tests${RESET}\n`);

test('every documented error code has its own text', () => {
  const codes = ['NETWORK', 'VALIDATION_ERROR', 'DIALOG_NOT_FOUND', 'REQUEST_NOT_FOUND', 'DIALOG_TERMINAL',
    'PENDING_REQUESTS', 'INVALID_TRANSITION', 'RUNTIME_BUSY', 'RESET_DISABLED', 'PAYLOAD_TOO_LARGE', 'INTERNAL_SERVER_ERROR'];
  const texts = codes.map((c) => errorMessage(err(c)));
  for (const t of texts) assert.ok(!t.startsWith('Unexpected error'), t);
  assert.equal(new Set(texts).size, codes.length, 'texts must differ');
});

test('PENDING_REQUESTS names the seq(s) to retry', () => {
  assert.equal(
    errorMessage(err('PENDING_REQUESTS', { details: { pending_seqs: [3] } })),
    'Cannot complete yet — seq 3 has no answer. Retry seq 3 first.',
  );
  assert.equal(
    errorMessage(err('PENDING_REQUESTS', { details: { pending_seqs: [2, 3, 5] } })),
    'Cannot complete yet — seq 2, 3 and 5 have no answer. Retry seq 2, 3 and 5 first.',
  );
  assert.match(errorMessage(err('PENDING_REQUESTS')), /Retry them first/);
});

test('INVALID_TRANSITION from INITIATED says to send a request first', () => {
  assert.match(errorMessage(err('INVALID_TRANSITION', { message: 'Invalid lifecycle transition: INITIATED → COMMITTED' })), /send at least one request/);
  assert.doesNotMatch(errorMessage(err('INVALID_TRANSITION', { message: 'Invalid lifecycle transition: COMMITTED → FAILED' })), /send at least/);
});

test('VALIDATION_ERROR shows the first zod issue', () => {
  const t = errorMessage(err('VALIDATION_ERROR', { details: [{ path: ['task_id'], message: 'String must contain at least 1 character(s)' }] }));
  assert.equal(t, 'The backend rejected the input — task_id: String must contain at least 1 character(s).');
});

test('NETWORK, RUNTIME_BUSY, DIALOG_TERMINAL wording', () => {
  assert.match(errorMessage(err('NETWORK')), /not reachable/);
  assert.match(errorMessage(err('RUNTIME_BUSY')), /busy/);
  assert.match(errorMessage(err('DIALOG_TERMINAL')), /already finished/);
});

test('unknown codes and non-API errors never crash', () => {
  assert.equal(errorMessage(err('SOMETHING_NEW', { message: 'boom' })), 'Unexpected error (SOMETHING_NEW): boom');
  assert.equal(errorMessage(new Error('plain')), 'Unexpected error: plain');
  assert.equal(errorMessage(undefined), 'Unexpected error: undefined');
});

const base = { dialog_id: 'dlg-1-x', task_id: 'T', kind: 'send', seq: 3, dialog_failed: false, dialog: { state: 'PROCESSING' } };

test('outcome lines: ok, duplicate, request lost, reply lost, rejected, budget', () => {
  assert.equal(outcomeMessage({ ...base, delivery: 'delivered', outcome: 'ok' }),
    'seq 3 · processed · work done · reply received · task PROCESSING');
  assert.equal(outcomeMessage({ ...base, kind: 'retry', delivery: 'delivered', outcome: 'duplicate' }),
    'retry of seq 3 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING');
  assert.equal(outcomeMessage({ ...base, delivery: 'request_dropped', outcome: 'no_answer' }),
    'seq 3 · request lost · B never saw it · retry it · task PROCESSING');
  assert.equal(outcomeMessage({ ...base, delivery: 'response_dropped', outcome: 'no_answer' }),
    'seq 3 · reply lost · B processed it · retry it to get the answer · task PROCESSING');
  assert.equal(outcomeMessage({ ...base, kind: 'retry', delivery: 'delivered', outcome: 'rejected', error_code: 'DIALOG_TERMINAL', dialog: { state: 'FAILED' } }),
    'retry of seq 3 · refused by B · task already finished, new work refused · no work done · task FAILED');
  assert.equal(outcomeMessage({ ...base, kind: 'retry', delivery: 'request_dropped', outcome: 'no_answer', dialog_failed: true, dialog: { state: 'FAILED' } }),
    'retry of seq 3 · request lost · B never saw it · retry it · retry limit reached → task FAILED · task FAILED');
});

test('restart and dialog lines', () => {
  assert.equal(restartMessage({ target: 'B', scope: 'process', recovered: [{}, {}] }),
    'whole backend process restarted from the SQLite file (Adapter B requested) · 2 unfinished tasks reloaded');
  assert.match(restartMessage({ target: 'A', recovered: [] }), /0 unfinished tasks/);
  assert.equal(dialogMessage('complete', { state: 'COMMITTED' }), 'task completed → COMMITTED');
  assert.equal(dialogMessage('complete', { state: 'RECOVERED' }), 'task completed after a restart → RECOVERED');
  assert.equal(dialogMessage('abort', { state: 'FAILED' }), 'task aborted by the operator → FAILED');
  assert.equal(dialogMessage('create', { task_id: 'T1', dialog_id: 'dlg-1-a', state: 'INITIATED' }), 'new task T1 · dlg-1-a · INITIATED');
  assert.ok(scenario4.dialogs.length > 0);   // fixture sanity
});

const failed = results.filter((r) => !r).length;
console.log(`\n${failed ? RED : GREEN}${results.length - failed}/${results.length} checks passed${RESET}\n`);
if (failed) process.exitCode = 1;
