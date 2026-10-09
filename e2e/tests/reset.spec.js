import { expect, test } from '../support/fixtures.js';
import { SCENARIOS } from '../../Front/frontend/src/lib/constants.js';

test('F. header "Start over": tasks, results and feed cleared; backend epoch changed', async ({ app, api, page }) => {
  const card = app.card(SCENARIOS[2].title);
  await card.getByRole('button', { name: 'Run demo' }).click();
  await expect(card.getByText(/^Passed in /)).toBeVisible({ timeout: 60_000 });
  await app.expectFeed('Duplicate of packet 1 blocked');
  const before = await api.state();
  expect(before.metrics.dialogs_total).toBe(1);

  await app.banner.getByRole('button', { name: 'Start over' }).click();

  await expect(app.tasks.getByText('No tasks yet', { exact: true })).toBeVisible();
  await expect(app.demos.getByText('Not run yet', { exact: true })).toHaveCount(5);
  await expect(app.demos.getByText(/of 5 passed$/)).toHaveCount(0);
  await expect(app.feed.getByText('Demo data wiped — starting fresh')).toBeVisible();
  await expect(app.feed.getByText('Duplicate of packet 1 blocked')).toHaveCount(0);
  await expect(page.locator('article').filter({ hasText: 'Total Tasks Processed' })).toContainText('No tasks yet');

  const after = await api.state();
  expect(after.runtime.epoch).not.toBe(before.runtime.epoch);
  expect(after.metrics.dialogs_total).toBe(0);
  expect(after.dialogs).toEqual([]);
  expect((await api.scenarios()).scenarios.every((s) => s.last_result === null)).toBe(true);
});
