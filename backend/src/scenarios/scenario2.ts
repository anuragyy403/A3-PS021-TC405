/**
 * Scenario 2 — Request Lost → Retry
 * Mirrors tests/scenarios.test.ts (Scenario 2).
 */

import type { ScenarioScript } from './types.js';

export const scenario2: ScenarioScript = async (ops, ctx, { read }) => {
  ctx.step('Create D1/T1', 'head');
  const d1 = (await ops.startDialog(ctx.taskId('T1'))).dialog_id;
  await ctx.pause();

  ctx.step('Send seq 1 — the request is lost before Adapter B receives it', 'warn');
  const lost = await ops.send(d1, { op: 'work' }, 'drop_request');
  ctx.check('request dropped', lost.delivery === 'request_dropped', `delivery=${lost.delivery}`);
  ctx.check('no processed record yet', lost.dialog.processed_count === 0, `processed_count=${lost.dialog.processed_count}`);
  ctx.check('seq 1 still pending at Adapter A', lost.dialog.pending_seqs.join(',') === '1', `pending=[${lost.dialog.pending_seqs}]`);
  await ctx.pause();

  ctx.step('Retry the same request (same dialog_id, task_id, seq)');
  const retry = await ops.retry(d1, 1);
  ctx.check('retry processed as new from B\'s view', retry.outcome === 'ok', `outcome=${retry.outcome}`);
  const after = read.getDialog(d1).dialog;
  ctx.check('side effect executed once', after.processed_count === 1, `processed_count=${after.processed_count}`);
  ctx.check('dialog PROCESSING', after.state === 'PROCESSING', `state=${after.state}`);
  await ctx.pause();

  ctx.step('Adapter A completes the task');
  const done = await ops.complete(d1);
  ctx.check('dialog COMMITTED', done.state === 'COMMITTED', `state=${done.state}`);
};
