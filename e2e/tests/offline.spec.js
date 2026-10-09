import { expect, test } from '../support/fixtures.js';
import { SCENARIOS } from '../../Front/frontend/src/lib/constants.js';

/**
 * E. A REAL OS-process stop and restart of the backend on the same SQLite file
 * (stronger than the in-process "Restart Adapter" button, which rebuilds the
 * adapters inside one process).
 */
test.describe('E. offline and recovery', () => {
  // While the backend is down the Vite proxy answers 500 (body-less), which the
  // browser logs as a failed resource load.
  test.use({ allowHttpStatuses: [500] });

  test('backend killed → UI unreachable, controls paused, NETWORK text; restarted on the same DB → reconnects, tasks kept', async ({ app, api, backend }) => {
    const open = await app.createTask('e2e-offline-open');
    await app.send('No fault');
    await expect(app.result).toHaveText('seq 1 · processed · work done · reply received · task PROCESSING');

    const done = await app.createTask('e2e-offline-done');
    await app.send('No fault');
    await expect(app.result).toHaveText('seq 1 · processed · work done · reply received · task PROCESSING');
    await app.clickAndWait(app.completeButton);
    await expect(app.result).toHaveText('task completed → COMMITTED');

    // the UI has caught up with both tasks before the crash
    await expect(app.taskRow(open.dialogId)).toContainText('In progress');
    await expect(app.taskRow(done.dialogId)).toContainText('Completed');

    const before = await api.state();
    const dbFile = before.runtime.db_path_name;

    // --- crash: kill the backend OS process --------------------------------
    await backend.stop();

    await expect(app.unreachablePill).toBeVisible();
    await expect(app.banner.getByText('Disconnected', { exact: true })).toBeVisible();
    await expect(app.hint).toHaveText('The backend is not reachable — controls are paused until it is back.');
    for (const button of app.manualButtons()) await expect(button).toBeDisabled();
    // the task list keeps showing what it last knew
    await expect(app.taskRow(open.dialogId)).toContainText('In progress');
    await expect(app.taskRow(done.dialogId)).toContainText('Completed');

    // an action that is still clickable reports the NETWORK error text
    await app.card(SCENARIOS[1].title).getByRole('button', { name: 'Run demo' }).click();
    await expect(app.alert).toContainText('Demo 2 did not run: The backend is not reachable — is it running (backend/: npm run dev)?');
    await app.alert.getByRole('button', { name: 'Dismiss this message' }).click();
    await expect(app.alert).toHaveCount(0);

    // --- restart: same DB file, new process ---------------------------------
    await backend.start();
    await expect(app.livePill).toBeVisible({ timeout: 30_000 });
    await expect(app.banner.getByText('All connected', { exact: true })).toBeVisible();
    await expect(app.hint).not.toHaveText(/not reachable/);
    await expect(app.newTaskButton).toBeEnabled();

    const after = await api.state();
    expect(after.runtime.db_path_name).toBe(dbFile);
    expect(after.runtime.epoch).not.toBe(before.runtime.epoch);       // a new process = a new event-log epoch
    const openNow = await api.dialog(open.dialogId);
    const doneNow = await api.dialog(done.dialogId);
    expect([openNow.dialog.task_id, openNow.dialog.state, openNow.dialog.restored, openNow.dialog.processed_count, openNow.dialog.next_seq])
      .toEqual([open.taskId, 'PROCESSING', true, 1, 2]);              // reloaded by recover() at boot
    expect([doneNow.dialog.task_id, doneNow.dialog.state, doneNow.dialog.processed_count]).toEqual([done.taskId, 'COMMITTED', 1]);

    await expect(app.taskRow(open.dialogId)).toContainText('In progress');
    await expect(app.taskRow(done.dialogId)).toContainText('Completed');
    await app.expectFeed('Unfinished task reloaded from the SQLite file');

    // the reloaded task continues with the next seq
    await app.taskRow(open.dialogId).click();
    await expect(app.sendButton).toHaveText('Send seq 2');
    await app.send('No fault');
    await expect(app.result).toHaveText('seq 2 · processed · work done · reply received · task PROCESSING');
    await app.clickAndWait(app.completeButton);
    await expect(app.result).toHaveText('task completed after a restart → RECOVERED');
    expect((await api.dialog(open.dialogId)).dialog.state).toBe('RECOVERED');
  });
});
