/**
 * Scenario 1 — Multiple Dialogs + Retry → Correct Correlation
 * Mirrors tests/scenarios.test.ts (Scenario 1).
 */

import type { ScenarioScript } from './types.js';

export const scenario1: ScenarioScript = async (ops, ctx, { read }) => {
  ctx.step('Create two dialogs: D1/T1 and D2/T2', 'head');
  const t1 = ctx.taskId('T1');
  const t2 = ctx.taskId('T2');
  const d1 = (await ops.startDialog(t1)).dialog_id;
  const d2 = (await ops.startDialog(t2)).dialog_id;
  ctx.check('two distinct dialogs exist', d1 !== d2, `${d1} / ${d2}`);
  await ctx.pause();

  ctx.step('Send D2 seq 1 — the request is lost before Adapter B receives it', 'warn');
  const lost = await ops.send(d2, { op: 'd2-work' }, 'drop_request');
  ctx.check('D2 seq 1 request dropped', lost.delivery === 'request_dropped', `delivery=${lost.delivery}`);
  ctx.check('Adapter B never saw it', lost.dialog.processed_count === 0, `processed_count=${lost.dialog.processed_count}`);
  await ctx.pause();

  ctx.step('Retry the same logical request: D2 / T2 / seq 1');
  const retry = await ops.retry(d2, 1);
  ctx.check('retry processed (original never arrived, so not a duplicate)', retry.outcome === 'ok', `outcome=${retry.outcome}`);
  ctx.check('retry correlated to D2/T2, not D1/T1',
    retry.response?.dialog_id === d2 && retry.response?.task_id === t2,
    `dialog=${retry.response?.dialog_id === d2 ? 'D2' : retry.response?.dialog_id}`);
  ctx.check('D2 processed exactly one request', read.getDialog(d2).dialog.processed_count === 1,
    `processed_count=${read.getDialog(d2).dialog.processed_count}`);
  ctx.check('D1 untouched', read.getDialog(d1).dialog.processed_count === 0,
    `processed_count=${read.getDialog(d1).dialog.processed_count}`);
  await ctx.pause();

  ctx.step('Adapter A completes D2');
  const done = await ops.complete(d2);
  ctx.check('D2 COMMITTED', done.state === 'COMMITTED', `state=${done.state}`);
  ctx.check('D1 stays INITIATED', read.getDialog(d1).dialog.state === 'INITIATED', `state=${read.getDialog(d1).dialog.state}`);
};
