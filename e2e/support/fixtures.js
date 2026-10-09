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
import { BACKEND_URL, BackendProcess } from './backend.js';

class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status} ${body?.error ?? ''} ${body?.message ?? ''}`.trim());
    this.status = status;
    this.code = body?.error ?? null;
    this.body = body;
  }
}

export function createApi() {
  async function call(method, path, body) {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }
  const api = {
    call,
    state: () => call('GET', '/api/state'),
    dialog: (id) => call('GET', `/api/dialogs/${encodeURIComponent(id)}`),
    scenarios: () => call('GET', '/api/scenarios'),
    /** POST /api/reset, waiting out a run that still holds the runtime lock. */
    async reset() {
      const until = Date.now() + 60_000;
      for (;;) {
        try {
          return await call('POST', '/api/reset', { confirm: 'RESET' });
        } catch (error) {
          if (error.code !== 'RUNTIME_BUSY' || Date.now() > until) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
  };
  return api;
}

/** Locators and small actions on the dashboard, by role / visible text. */
export class Dashboard {
  constructor(page) {
    this.page = page;
    const section = (name) => page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
    this.pipeline = section('Live message pipeline');
    this.demos = section('Demonstrations');
    this.tasks = section('Tasks');
    this.feed = section('What is happening');
    this.banner = page.getByRole('banner');
    this.livePill = page.getByText('Live backend', { exact: true });
    this.unreachablePill = page.getByText('Live backend · unreachable', { exact: true });
    this.alert = page.getByRole('alert');

    // manual controls (inside the pipeline panel; feed rows are buttons too)
    const manual = this.pipeline;
    this.manual = manual;
    this.taskIdInput = manual.getByLabel('Task id for the new task');
    this.newTaskButton = manual.getByRole('button', { name: 'New task', exact: true });
    this.sendButton = manual.getByRole('button', { name: /^Send seq / });
    this.retryButton = manual.getByRole('button', { name: /^Retry seq / });
    this.duplicateButton = manual.getByRole('button', { name: /^Send duplicate of seq / });
    this.completeButton = manual.getByRole('button', { name: 'Complete task', exact: true });
    this.abortButton = manual.getByRole('button', { name: 'Abort task', exact: true });
    this.reasonInput = manual.getByLabel('Reason for aborting');
    this.retrySelect = manual.getByLabel('Packet to retry');
    this.result = manual.getByRole('status');
    this.hint = manual.getByTestId('manual-hint');
    this.recovered = manual.getByTestId('manual-recovered');
  }

  sendFault(label) {
    return this.manual.getByRole('radiogroup', { name: 'Fault for the next request' }).getByRole('radio', { name: label, exact: true });
  }

  retryFault(label) {
    return this.manual.getByRole('radiogroup', { name: 'Fault for the retry' }).getByRole('radio', { name: label, exact: true });
  }

  restartButton(adapter) {
    return this.manual.getByRole('button', { name: `Restart Adapter ${adapter}`, exact: true });
  }

  card(title) {
    return this.demos.locator('article').filter({ has: this.page.getByRole('heading', { name: title, exact: true }) });
  }

  taskRow(dialogId) {
    return this.tasks.getByRole('button').filter({ hasText: dialogId });
  }

  /** Every mutating manual control (for enabled/disabled checks). */
  manualButtons() {
    return [this.newTaskButton, this.sendButton, this.retryButton, this.duplicateButton, this.completeButton,
      this.abortButton, this.restartButton('A'), this.restartButton('B')];
  }

  /** Click a control and wait for the one API mutation it triggers to answer. */
  async clickAndWait(locator) {
    const [response] = await Promise.all([
      this.page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/')),
      locator.click(),
    ]);
    return response;
  }

  /** New task via the panel; returns { dialogId, taskId } parsed from the result line. */
  async createTask(taskId) {
    await this.taskIdInput.fill(taskId);
    await this.clickAndWait(this.newTaskButton);
    await expect(this.result).toHaveText(new RegExp(`^new task ${taskId} · dlg-\\S+ · INITIATED$`));
    const dialogId = /· (dlg-\S+) ·/.exec(await this.result.textContent())[1];
    await expect(this.taskRow(dialogId)).toBeVisible();
    return { dialogId, taskId };
  }

  async send(fault = 'No fault') {
    await this.sendFault(fault).click();
    return this.clickAndWait(this.sendButton);
  }

  /** The activity feed contains a row with this text (searched, so older rows count too). */
  async expectFeed(text) {
    const search = this.feed.getByRole('searchbox', { name: 'Search the activity feed' });
    await search.fill(text);
    await expect(this.feed.getByRole('listitem').filter({ hasText: text }).first()).toBeVisible();
    await search.fill('');
  }

  /** Dashboard loaded against an empty, reset backend. */
  async expectIdleAndEmpty() {
    await expect(this.livePill).toBeVisible();
    await expect(this.tasks.getByText('No tasks yet', { exact: true })).toBeVisible();
    await expect(this.demos.getByText('Not run yet', { exact: true })).toHaveCount(5);
  }
}

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

export { expect };
