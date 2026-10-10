import { expect, test } from '../support/fixtures.js';
import { SCENARIOS } from '../../Front/frontend/src/lib/constants.js';

/** D. Manual flows, driven by clicking the ManualControls panel (never the API). */

test('Da. reply lost → retry → duplicate blocked (work count 1) → complete → COMMITTED', async ({ app, api }) => {
  const { dialogId, taskId } = await app.createTask('e2e-reply-lost');

  await app.send('Lose the reply');
  await expect(app.result).toHaveText('seq 1 · reply lost · B processed it · retry it to get the answer · task PROCESSING');
  let d = (await api.dialog(dialogId)).dialog;
  expect([d.state, d.processed_count, d.side_effects_since_boot, d.pending_seqs]).toEqual(['PROCESSING', 1, 1, [1]]);

  await expect(app.retryButton).toHaveText('Retry seq 1');
  await app.clickAndWait(app.retryButton);
  await expect(app.result).toHaveText('retry of seq 1 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING');
  d = (await api.dialog(dialogId)).dialog;
  // side_effects_since_boot counts executions of the work itself: still 1 = not run again
  expect([d.processed_count, d.side_effects_since_boot, d.pending_seqs, d.duplicates_since_boot]).toEqual([1, 1, [], 1]);

  await expect(app.duplicateButton).toHaveText('Send duplicate of seq 1');
  await app.clickAndWait(app.duplicateButton);
  await expect(app.result).toHaveText('retry of seq 1 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING');
  d = (await api.dialog(dialogId)).dialog;
  expect([d.processed_count, d.side_effects_since_boot, d.duplicates_since_boot]).toEqual([1, 1, 2]);
  const row = app.taskRow(dialogId);
  await expect(row).toContainText('1 of 1 work items');
  await expect(row).toContainText('2 duplicates blocked since server start');

  await app.clickAndWait(app.completeButton);
  await expect(app.result).toHaveText('task completed → COMMITTED');
  d = (await api.dialog(dialogId)).dialog;
  expect([d.dialog_id, d.task_id, d.state, d.processed_count]).toEqual([dialogId, taskId, 'COMMITTED', 1]);
  await expect(row).toContainText('Completed');
  await expect(row).toContainText('All 1 work items completed, none repeated');
});

test('Db. request lost → "sent, not processed yet" → retry processed → complete → COMMITTED', async ({ app, api }) => {
  const { dialogId } = await app.createTask('e2e-request-lost');
  const row = app.taskRow(dialogId);

  await app.send('Lose the request');
  await expect(app.result).toHaveText('seq 1 · request lost · B never saw it · retry it · task INITIATED');
  await expect(row.locator('[title="Packet 1: sent, not processed yet"]')).toBeVisible();
  let detail = await api.dialog(dialogId);
  expect([detail.dialog.state, detail.dialog.processed_count, detail.dialog.pending_seqs]).toEqual(['INITIATED', 0, [1]]);
  expect(detail.ledger.map((r) => r.status)).toEqual(['pending_unprocessed']);

  await app.clickAndWait(app.retryButton);
  await expect(app.result).toHaveText('retry of seq 1 · processed · work done · reply received · task PROCESSING');
  await expect(row.locator('[title="Packet 1: processed"]')).toBeVisible();
  detail = await api.dialog(dialogId);
  expect([detail.dialog.state, detail.dialog.processed_count, detail.dialog.side_effects_since_boot, detail.dialog.pending_seqs]).toEqual(['PROCESSING', 1, 1, []]);
  expect(detail.ledger.map((r) => r.status)).toEqual(['acked']);

  await app.clickAndWait(app.completeButton);
  await expect(app.result).toHaveText('task completed → COMMITTED');
  expect((await api.dialog(dialogId)).dialog.state).toBe('COMMITTED');
  await expect(row).toContainText('Completed');
});

test('Dc. restart mid-task: Restart Adapter A → recovered row → retry/duplicate → seq 4 → RECOVERED, same ids', async ({ app, api }) => {
  const { dialogId, taskId } = await app.createTask('e2e-restart');

  await app.send('No fault');
  await expect(app.result).toHaveText('seq 1 · processed · work done · reply received · task PROCESSING');
  await app.send('No fault');
  await expect(app.result).toHaveText('seq 2 · processed · work done · reply received · task PROCESSING');
  await app.send('Lose the reply');
  await expect(app.result).toHaveText('seq 3 · reply lost · B processed it · retry it to get the answer · task PROCESSING');

  await app.clickAndWait(app.restartButton('A'));
  await expect(app.result).toHaveText('whole backend process restarted from the SQLite file (Adapter A requested) · 1 unfinished task reloaded');
  await expect(app.recovered).toContainText(`${dialogId} · ${taskId} · PROCESSING · next_seq 4 · no answer yet: [3]`);
  let d = (await api.dialog(dialogId)).dialog;
  expect([d.dialog_id, d.task_id, d.state, d.restored, d.next_seq, d.pending_seqs, d.processed_count])
    .toEqual([dialogId, taskId, 'PROCESSING', true, 4, [3], 3]);

  await expect(app.retryButton).toHaveText('Retry seq 3');
  await app.clickAndWait(app.retryButton);
  await expect(app.result).toHaveText('retry of seq 3 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING');
  await expect(app.duplicateButton).toHaveText('Send duplicate of seq 3');
  await app.clickAndWait(app.duplicateButton);
  await expect(app.result).toHaveText('retry of seq 3 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING');
  // the restarted process has run no work at all: both retries were answered from the SQLite record
  d = (await api.dialog(dialogId)).dialog;
  expect([d.processed_count, d.side_effects_since_boot, d.pending_seqs]).toEqual([3, 0, []]);

  await expect(app.sendButton).toHaveText('Send seq 4');
  await app.send('No fault');
  await expect(app.result).toHaveText('seq 4 · processed · work done · reply received · task PROCESSING');

  await app.clickAndWait(app.completeButton);
  await expect(app.result).toHaveText('task completed after a restart → RECOVERED');
  d = (await api.dialog(dialogId)).dialog;
  expect([d.dialog_id, d.task_id, d.state, d.restored, d.processed_count, d.next_seq, d.pending_seqs])
    .toEqual([dialogId, taskId, 'RECOVERED', true, 4, 5, []]);
  expect(d.side_effects_since_boot).toBe(1);   // only seq 4 ran after the restart
  const state = await api.state();
  expect(state.dialogs.filter((x) => x.task_id === taskId)).toHaveLength(1);
  const row = app.taskRow(dialogId);
  await expect(row).toContainText('Recovered');
  await expect(row).toContainText('Finished after a restart — 4 work items, none repeated');
});

test.describe('Dd. error texts and finished-task rules', () => {
  test.use({ allowHttpStatuses: [409] });   // the two expected 409 answers below

  test('INVALID_TRANSITION, PENDING_REQUESTS, finished task: only retry allowed', async ({ app, api }) => {
    const { dialogId } = await app.createTask('e2e-errors');

    await app.clickAndWait(app.completeButton);
    await expect(app.result).toHaveText('Nothing to complete yet — send at least one request before completing this task.');
    expect((await api.dialog(dialogId)).dialog.state).toBe('INITIATED');

    await app.send('Lose the reply');
    await expect(app.result).toHaveText('seq 1 · reply lost · B processed it · retry it to get the answer · task PROCESSING');
    const response = await app.clickAndWait(app.completeButton);
    expect(response.status()).toBe(409);
    expect((await response.json()).details.pending_seqs).toEqual([1]);
    await expect(app.result).toHaveText('Cannot complete yet — seq 1 has no answer. Retry seq 1 first.');
    expect((await api.dialog(dialogId)).dialog.state).toBe('PROCESSING');

    await app.clickAndWait(app.retryButton);
    await app.clickAndWait(app.completeButton);
    await expect(app.result).toHaveText('task completed → COMMITTED');

    for (const button of [app.sendButton, app.completeButton, app.abortButton]) await expect(button).toBeDisabled();
    await expect(app.retryButton).toBeEnabled();
    await expect(app.hint).toContainText('This task is finished (Completed).');
    await app.clickAndWait(app.retryButton);
    await expect(app.result).toHaveText('retry of seq 1 · duplicate blocked · work NOT repeated · stored answer returned · task COMMITTED');
    const d = (await api.dialog(dialogId)).dialog;
    expect([d.state, d.processed_count]).toEqual(['COMMITTED', 1]);
  });
});

test('De. busy: a running scenario disables every manual control with the busy hint', async ({ app }) => {
  const { dialogId } = await app.createTask('e2e-busy');
  await expect(app.sendButton).toBeEnabled();

  const card = app.card(SCENARIOS[4].title);
  await card.getByRole('button', { name: 'Run demo' }).click();
  await expect(app.hint).toHaveText('Busy — a demo or another action is running on the backend. Controls unlock when it finishes.');
  for (const button of app.manualButtons()) await expect(button).toBeDisabled();

  await expect(card.getByText(/^Passed in /)).toBeVisible({ timeout: 60_000 });
  await expect(app.hint).toHaveCount(0);   // selected task is open: no hint
  for (const button of [app.newTaskButton, app.sendButton, app.completeButton, app.abortButton]) await expect(button).toBeEnabled();
  await expect(app.taskRow(dialogId)).toContainText('Not started yet');
});

test('Df. abort with a reason → FAILED; task line wording', async ({ app, api }) => {
  const { dialogId } = await app.createTask('e2e-abort');
  await app.send('No fault');
  await expect(app.result).toHaveText('seq 1 · processed · work done · reply received · task PROCESSING');

  await app.reasonInput.fill('e2e operator abort');
  await app.clickAndWait(app.abortButton);
  await expect(app.result).toHaveText('task aborted by the operator → FAILED');
  const d = (await api.dialog(dialogId)).dialog;
  expect([d.state, d.terminal, d.processed_count]).toEqual(['FAILED', true, 1]);
  const row = app.taskRow(dialogId);
  await expect(row).toContainText('Failed');
  await expect(row).toContainText('Stopped before finishing — the retry limit was reached or it was aborted');
  await app.expectFeed('e2e operator abort');
});
