/**
 * Scenario 3 — Response Lost → Duplicate Request
 * Mirrors tests/scenarios.test.ts (Scenario 3).
 *
 * Shows duplicate-side-effect prevention once the original request has been
 * durably recorded as processed — not exactly-once delivery.
 */

import type { ScenarioScript } from './types.js';

export const scenario3: ScenarioScript = async (ops, ctx, { read }) => {
  ctx.step('Create D1/T1', 'head');
  const d1 = (await ops.startDialog(ctx.taskId('T1'))).dialog_id;
  await ctx.pause();

  ctx.step('Send seq 1 — Adapter B processes it, then the response is lost', 'warn');
  const lost = await ops.send(d1, { op: 'critical-work' }, 'drop_response');
  ctx.check('response dropped', lost.delivery === 'response_dropped', `delivery=${lost.delivery}`);
  ctx.check('B executed the side effect once', lost.dialog.processed_count === 1 && lost.dialog.side_effects_since_boot === 1,
    `processed_count=${lost.dialog.processed_count}, side_effects=${lost.dialog.side_effects_since_boot}`);
  await ctx.pause();

  ctx.step('Retry the same logical request (D1, T1, seq 1)');
  const retry = await ops.retry(d1, 1);
  ctx.check('retry classified as duplicate', retry.outcome === 'duplicate', `outcome=${retry.outcome}`);
  const after = read.getDialog(d1).dialog;
  ctx.check('side effect not repeated', after.processed_count === 1 && after.side_effects_since_boot === 1,
    `processed_count=${after.processed_count}, side_effects=${after.side_effects_since_boot}`);
  await ctx.pause();

  ctx.step('Adapter A completes the task');
  const done = await ops.complete(d1);
  ctx.check('dialog COMMITTED', done.state === 'COMMITTED', `state=${done.state}`);
};
