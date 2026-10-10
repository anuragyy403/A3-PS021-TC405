import { expect, test } from '../support/fixtures.js';

test('A. smoke: live backend, 4/4 components online, five cards titled as the backend registry', async ({ app, api, page }) => {
  await expect(app.livePill).toBeVisible();
  await expect(app.banner.getByText('All connected', { exact: true })).toBeVisible();
  await expect(page.getByText(/^4 of 4 components online · running for /)).toBeVisible();

  const { scenarios } = await api.scenarios();
  expect(scenarios.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
  const cards = app.demos.locator('article');
  await expect(cards).toHaveCount(5);
  for (const [index, scenario] of scenarios.entries()) {
    const shown = (await cards.nth(index).getByRole('heading').textContent()).trim();
    expect(`Scenario ${scenario.id} — ${shown}`).toBe(scenario.title);
    await expect(cards.nth(index).getByText('Not run yet', { exact: true })).toBeVisible();
    expect(scenario.last_result).toBeNull();
  }

  const state = await api.state();
  expect(Object.values(state.nodes).map((n) => n.status)).toEqual(['online', 'online', 'online', 'online']);
  expect(state.metrics.dialogs_total).toBe(0);
  await expect(app.tasks.getByText('No tasks yet', { exact: true })).toBeVisible();
  await expect(page.getByText('Browser simulation')).toHaveCount(0);
  // console/page errors are asserted by the app fixture after every test
});
