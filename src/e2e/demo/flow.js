/**
 * The demo talk track (docs/DEMO_SCRIPT.md steps 1–6 and 8) as one scripted
 * flow, shared by record.mjs (video) and screenshots.mjs (PNGs).  Every step
 * waits for the exact strings the UI shows, so the assets cannot drift from the
 * real behaviour.
 */
import { expect } from '@playwright/test';
import { Dashboard } from '../support/dashboard.js';
import { SCENARIOS } from '../../Front/frontend/src/lib/constants.js';

export const TASK_ID = 'order-1001';

/** A caption bar over the page (recording only — not part of the product UI). */
export async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;'
        + 'background:rgba(2,6,23,.92);color:#e2e8f0;border:1px solid rgba(148,163,184,.35);border-radius:14px;'
        + 'padding:12px 20px;font:600 18px system-ui,Segoe UI,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.6);max-width:90vw';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

/**
 * @param {import('@playwright/test').Page} page  dashboard already loaded, backend empty
 * @param {{ pause?: (ms:number)=>Promise<void>, shot?: (name:string, target)=>Promise<void>, say?: (text:string)=>Promise<void> }} hooks
 */
export async function runTalkTrack(page, { pause = async () => {}, shot = async () => {}, say = async () => {} } = {}) {
  const app = new Dashboard(page);
  const row = (id) => app.taskRow(id);
  // wait for the exact result line, then bring it to the middle of the screen (it can sit below the fold)
  const status = async (text) => {
    await expect(app.result).toHaveText(text);
    await app.result.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  };

  // ---------------------------------------------------------------- 0 / initial
  await expect(app.livePill).toBeVisible();
  await shot('01-initial', null);

  // ---------------------------------------------------------------- 1 start a task
  await say('1 · Start a task: Adapter A opens a dialog (dialog_id + task_id), state INITIATED');
  await pause(1500);
  const { dialogId } = await app.createTask(TASK_ID);
  await expect(row(dialogId)).toContainText('Not started yet');
  await pause(2500);

  // ---------------------------------------------------------------- 2 normal request
  await say('2 · Normal request: seq 1 is processed once → PROCESSING');
  await app.send('No fault');
  await status('seq 1 · processed · work done · reply received · task PROCESSING');
  await expect(row(dialogId)).toContainText('1 work item completed so far');
  await pause(2500);

  // ---------------------------------------------------------------- 3 request lost
  await say('3 · Request lost: B never saw seq 2 → retry with the same ids → processed once');
  await app.send('Lose the request');
  await status('seq 2 · request lost · B never saw it · retry it · task PROCESSING');
  await expect(row(dialogId).locator('[title="Packet 2: sent, not processed yet"]')).toBeVisible();
  await pause(2500);
  await expect(app.retryButton).toHaveText('Retry seq 2');
  await app.clickAndWait(app.retryButton);
  await status('retry of seq 2 · processed · work done · reply received · task PROCESSING');
  await expect(row(dialogId)).toContainText('2 work items completed so far');
  await pause(2500);

  // ---------------------------------------------------------------- 4 reply lost
  await say('4 · Reply lost: B did the work for seq 3, A never heard back');
  await app.send('Lose the reply');
  await status('seq 3 · reply lost · B processed it · retry it to get the answer · task PROCESSING');
  await shot('02-reply-lost', app.pipeline);
  await pause(2500);
  await say('4 · Retry seq 3 → DUPLICATE: stored answer returned, work NOT repeated');
  await expect(app.retryButton).toHaveText('Retry seq 3');
  await app.clickAndWait(app.retryButton);
  await status('retry of seq 3 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING');
  await expect(row(dialogId)).toContainText('3 work items completed so far');
  await expect(row(dialogId)).toContainText('1 duplicate blocked since server start');
  await shot('03-duplicate-blocked', app.pipeline);
  await pause(3000);

  // ---------------------------------------------------------------- 5 correlation
  await say('5 · Correlation: Scenario 1 — two dialogs, the retry lands on D2 only, D1 untouched');
  const s1 = app.card(SCENARIOS[0].title);
  await s1.scrollIntoViewIfNeeded();
  await s1.getByRole('button', { name: 'Run demo' }).click();
  await expect(app.demos.getByText('Step by step', { exact: true })).toBeVisible();
  await expect(s1.getByText(/^Passed in /)).toBeVisible({ timeout: 60_000 });
  await pause(2500);
  await app.tasks.scrollIntoViewIfNeeded();
  await expect(app.tasks.getByRole('button').filter({ hasText: 'Not started yet' })).toHaveCount(1);
  await pause(2500);

  // ---------------------------------------------------------------- 6 restart mid-task
  await app.pipeline.scrollIntoViewIfNeeded();
  await say('6 · Restart mid-task: seq 4 is processed but its reply is lost, then Restart Adapter A');
  await expect(app.sendButton).toHaveText('Send seq 4');
  await app.send('Lose the reply');
  await status('seq 4 · reply lost · B processed it · retry it to get the answer · task PROCESSING');
  await pause(2000);
  await app.clickAndWait(app.restartButton('A'));
  await status('whole backend process restarted from the SQLite file (Adapter A requested) · 2 unfinished tasks reloaded');
  await expect(app.recovered).toContainText(`${dialogId} · ${TASK_ID} · PROCESSING · next_seq 5 · no answer yet: [4]`);
  await say('6 · Reloaded from the SQLite file: same dialog_id / task_id, next_seq 5, seq 4 still unanswered');
  await shot('04-recovered-row', app.pipeline);
  await pause(3500);
  await say('6 · Retry seq 4 → DUPLICATE (no work after the restart) → continue with seq 5 → complete');
  await expect(app.retryButton).toHaveText('Retry seq 4');
  await app.clickAndWait(app.retryButton);
  await status('retry of seq 4 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING');
  await pause(2000);
  await expect(app.sendButton).toHaveText('Send seq 5');
  await app.send('No fault');
  await status('seq 5 · processed · work done · reply received · task PROCESSING');
  await pause(1500);
  await app.clickAndWait(app.completeButton);
  await status('task completed after a restart → RECOVERED');
  await expect(row(dialogId)).toContainText('Recovered');
  await expect(row(dialogId)).toContainText('Finished after a restart — 5 work items, none repeated');
  await app.tasks.scrollIntoViewIfNeeded();
  await shot('05-recovered-task', app.tasks);
  await pause(3000);

  // ---------------------------------------------------------------- 8 run all five
  await say('8 · Run all five PS-021 scenarios on the backend');
  await app.demos.scrollIntoViewIfNeeded();
  await app.demos.getByRole('button', { name: 'Run all five' }).click();
  await expect(app.demos.getByText('5 of 5 passed', { exact: true })).toBeVisible({ timeout: 180_000 });
  await say('8 · 5 of 5 passed');
  await shot('06-five-of-five', app.demos);
  await pause(3500);
  return { dialogId };
}
