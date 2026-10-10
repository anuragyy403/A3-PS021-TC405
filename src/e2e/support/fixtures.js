/**
 * Playwright fixtures for the Nighthawks E2E suite.
 *
 *   backend  (worker, auto)  the backend OS process on :3101 with a fresh temp DB
 *   api                      direct HTTP access to that backend for cross-checks
 *   app                      a reset backend + the dashboard loaded and idle,
 *                            plus a Dashboard helper; fails the test on page
 *                            errors and unexpected console errors
 *
 * Options (test.use): allowHttpStatuses — HTTP error statuses the browser may
 * log as "Failed to load resource" in this test (e.g. 409 for an expected
 * PENDING_REQUESTS, 500 while the backend is deliberately stopped).
 */
import { test as base, expect } from '@playwright/test';
import { BackendProcess } from './backend.js';
import { Dashboard, createApi } from './dashboard.js';

const RESOURCE_ERROR = /Failed to load resource: the server responded with a status of (\d{3})/;

export const test = base.extend({
  allowHttpStatuses: [[], { option: true }],

  backend: [async ({}, use) => {
    const backend = new BackendProcess();
    await backend.start();
    await use(backend);
    await backend.dispose();
  }, { scope: 'worker', auto: true }],

  api: async ({}, use) => {
    await use(createApi());
  },

  app: async ({ page, backend, api, allowHttpStatuses }, use, testInfo) => {
    if (!backend.running) await backend.start();   // a previous test may have failed while it was stopped
    await api.reset();

    const consoleErrors = [];
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      const status = RESOURCE_ERROR.exec(text)?.[1];
      if (status && allowHttpStatuses.includes(Number(status))) return;
      consoleErrors.push(text);
    });

    // index.html loads Google Fonts from the internet; page.goto waits for the
    // load event, and that external request intermittently took ~9 s. Answer it
    // locally (empty stylesheet → system font fallback) so the suite is hermetic.
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

    await page.goto('/');
    const dashboard = new Dashboard(page);
    await dashboard.expectIdleAndEmpty();

    await use(dashboard);

    await testInfo.attach('console-errors', { body: JSON.stringify({ consoleErrors, pageErrors }, null, 2), contentType: 'application/json' });
    expect(pageErrors, 'page errors').toEqual([]);
    expect(consoleErrors, 'unexpected console errors').toEqual([]);
  },
});

export { expect, Dashboard, createApi };
