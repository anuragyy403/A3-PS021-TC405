import { expect, test } from '../support/fixtures.js';
import { SCENARIOS } from '../../Front/frontend/src/lib/constants.js';

/**
 * B. Each PS-021 scenario run from its card in the UI (real 400 ms step delay).
 * Expected final dialogs and key feed lines come from the backend scripts
 * (backend/src/scenarios/scenario1..5.ts).
 */
const PLAIN = { INITIATED: 'Not started yet', PROCESSING: 'In progress', COMMITTED: 'Completed', RECOVERED: 'Recovered', FAILED: 'Failed' };

const EXPECTED = {
  1: {
    dialogs: [{ suffix: 'T1', state: 'INITIATED', restored: false, processed: 0 }, { suffix: 'T2', state: 'COMMITTED', restored: false, processed: 1 }],
    feed: ['Packet 1 was lost before reaching the Receiver Agent', 'Retrying packet 1', 'Packet 1 received and processed'],
  },
  2: {
    dialogs: [{ suffix: 'T1', state: 'COMMITTED', restored: false, processed: 1 }],
    feed: ['Packet 1 was lost before reaching the Receiver Agent', 'Retrying packet 1', 'Packet 1 received and processed'],
  },
  3: {
    dialogs: [{ suffix: 'T1', state: 'COMMITTED', restored: false, processed: 1 }],
    feed: ['Reply for packet 1 was lost on the way back — the work WAS done', 'Retrying packet 1', 'Duplicate of packet 1 blocked'],
  },
  4: {
    dialogs: [{ suffix: 'T1', state: 'RECOVERED', restored: true, processed: 1 }],
    feed: ['Reply for packet 1 was lost on the way back — the work WAS done', 'Restarting the whole backend process (Adapter B was asked to restart)',
      'Unfinished task reloaded from the SQLite file', 'Duplicate of packet 1 blocked'],
  },
  5: {
    dialogs: [{ suffix: 'T1', state: 'RECOVERED', restored: true, processed: 4 }],
    feed: ['Reply for packet 3 was lost on the way back — the work WAS done', 'Restarting the whole backend process (Adapter A was asked to restart)',
      'Unfinished task reloaded from the SQLite file', 'Duplicate of packet 3 blocked', 'Duplicate of packet 1 blocked', 'Packet 4 received and processed'],
  },
};

for (const card of SCENARIOS) {
  test(`B${card.id}. scenario ${card.id} from its card: passes, final tasks in UI and API, key feed lines`, async ({ app, api }) => {
    const ui = app.card(card.title);
    await ui.getByRole('button', { name: 'Run demo' }).click();

    // live progress while it runs
    await expect(ui.getByRole('button', { name: 'Running...' })).toBeVisible();
    await expect(app.demos.getByText('Step by step', { exact: true })).toBeVisible();
    await expect(app.banner.getByText('Demo running', { exact: true })).toBeVisible();

    // finished: passed, all checks
    await expect(ui.getByText(/^Passed in /)).toBeVisible({ timeout: 60_000 });
    const result = (await api.scenarios()).scenarios.find((s) => s.id === card.id).last_result;
    expect(result.status).toBe('passed');
    expect(result.assertions.length).toBeGreaterThan(0);
    expect(result.assertions.every((a) => a.ok)).toBe(true);
    await expect(app.demos.getByText(new RegExp(`^Demo ${card.id} finished: all ${result.assertions.length} checks passed in `))).toBeVisible();
    await expect(app.demos.getByText(/^1 of 5 passed$/)).toBeVisible();

    // final dialogs: scenario result, API detail and the task list agree
    const expected = EXPECTED[card.id];
    expect(result.dialogs).toHaveLength(expected.dialogs.length);
    for (const want of expected.dialogs) {
      const got = result.dialogs.find((d) => d.task_id.endsWith(`-${want.suffix}`));
      expect(got, `dialog ${want.suffix}`).toBeTruthy();
      expect([got.final_state, got.restored]).toEqual([want.state, want.restored]);

      const detail = await api.dialog(got.dialog_id);
      expect(detail.dialog.state).toBe(want.state);
      expect(detail.dialog.restored).toBe(want.restored);
      expect(detail.dialog.processed_count).toBe(want.processed);
      expect(detail.dialog.task_id).toBe(got.task_id);

      const row = app.taskRow(got.dialog_id);
      await expect(row).toContainText(PLAIN[want.state]);
      await expect(row).toContainText(`${want.processed} of`);
      if (want.state === 'RECOVERED') await expect(row).toContainText('Finished after a restart');
    }
    const state = await api.state();
    expect(state.dialogs.map((d) => d.dialog_id).sort()).toEqual(result.dialogs.map((d) => d.dialog_id).sort());

    for (const line of expected.feed) await app.expectFeed(line);
  });
}

test('C. run all five: 5 of 5 passed; Tasks and Recovery cards match /api/state', async ({ app, api, page }) => {
  await app.demos.getByRole('button', { name: 'Run all five' }).click();
  await expect(app.demos.getByText('5 of 5 passed', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(app.banner.getByText('Demo running', { exact: true })).toHaveCount(0);

  const { scenarios } = await api.scenarios();
  expect(scenarios.map((s) => s.last_result?.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
  for (const card of SCENARIOS) await expect(app.card(card.title).getByText(/^Passed in /)).toBeVisible();

  const state = await api.state();
  const by = state.metrics.by_state;
  const restored = state.dialogs.filter((d) => d.restored);
  const restoredDone = restored.filter((d) => d.terminal);
  const succeeded = restoredDone.filter((d) => d.state === 'RECOVERED').length;
  const open = restored.length - restoredDone.length;

  // Known, expected behaviour (Phase 9 decision 6): Scenario 1 leaves its D1 INITIATED; the
  // later process restarts (S4, S5) reload it, so it counts as a restored task still open.
  expect(state.metrics.dialogs_total).toBe(6);
  expect(by).toEqual({ INITIATED: 1, PROCESSING: 0, COMMITTED: 3, RECOVERED: 2, FAILED: 0 });
  const s1d1 = scenarios[0].last_result.dialogs.find((d) => d.task_id.endsWith('-T1'));
  const s1d1Now = state.dialogs.find((d) => d.dialog_id === s1d1.dialog_id);
  expect([s1d1Now.state, s1d1Now.restored]).toEqual(['INITIATED', true]);
  expect([succeeded, restoredDone.length, open]).toEqual([2, 2, 1]);

  const tasksCard = page.locator('article').filter({ hasText: 'Total Tasks Processed' });
  await expect(tasksCard).toContainText(String(state.metrics.dialogs_total));
  await expect(tasksCard).toContainText(`${by.INITIATED} not started, ${by.COMMITTED + by.RECOVERED} finished successfully`);

  const recoveryCard = page.locator('article').filter({ hasText: 'Recovery Success Rate' });
  await expect(recoveryCard).toContainText(`${Math.round((succeeded / restoredDone.length) * 100)}%`);
  await expect(recoveryCard).toContainText(`${succeeded} of ${restoredDone.length} recoveries succeeded · ${open} restored task still open`);

  const dupCard = page.locator('article').filter({ hasText: 'Duplicates Blocked' });
  await expect(dupCard).toContainText(String(state.metrics.duplicates_since_boot));
});
