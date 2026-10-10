/**
 * Scenario 4 — Adapter B Restart → Durable State Recovery
 * Mirrors tests/scenarios.test.ts (Scenario 4).
 *
 * The restart is a full process restart (shared store): both adapter objects
 * are rebuilt from the SQLite file.
 */

import type { ScenarioScript } from './types.js';

export const scenario4: ScenarioScript = async (ops, ctx, { read }) => {
  ctx.step('Create D1/T1', 'head');
  const t1 = ctx.taskId('T1');
  const d1 = (await ops.startDialog(t1)).dialog_id;
  await ctx.pause();

  ctx.step('Send seq 1 — B processes it, the response is lost', 'warn');
  const lost = await ops.send(d1, { data: 'before-restart' }, 'drop_response');
  ctx.check('B processed seq 1', lost.dialog.processed_count === 1, `processed_count=${lost.dialog.processed_count}`);
  ctx.check('dialog PROCESSING before restart', lost.dialog.state === 'PROCESSING', `state=${lost.dialog.state}`);
  await ctx.pause();

  ctx.step('Restart Adapter B (process restart: reopen the SQLite file)', 'warn');
  const restart = await ops.restart('B');
  const rec = restart.recovered.find(r => r.dialog_id === d1);
  ctx.check('D1/T1 reloaded from the file', rec !== undefined && rec.task_id === t1 && rec.state === 'PROCESSING',
    rec ? `task=${rec.task_id === t1 ? 'T1' : rec.task_id}, state=${rec.state}` : 'not recovered');
  ctx.check('next_seq derived from durable state', rec?.next_seq === 2, `next_seq=${rec?.next_seq}`);
  ctx.check('seq 1 reported as in flight', rec?.pending_seqs.join(',') === '1', `pending=[${rec?.pending_seqs}]`);
  await ctx.pause();

  ctx.step('Retry the in-flight seq 1 with its stored payload');
  const retry = await ops.retry(d1, 1);
  ctx.check('retry recognised as duplicate after restart', retry.outcome === 'duplicate', `outcome=${retry.outcome}`);
  const result = retry.response?.result as { payload?: { data?: string } } | undefined;
  ctx.check('stored result returned', result?.payload?.data === 'before-restart', `payload.data=${result?.payload?.data}`);
  const after = read.getDialog(d1).dialog;
  ctx.check('restarted B ran no side effect', after.side_effects_since_boot === 0, `side_effects_since_boot=${after.side_effects_since_boot}`);
  ctx.check('seq 1 now acknowledged', after.pending_seqs.length === 0, `pending=[${after.pending_seqs}]`);
  await ctx.pause();

  ctx.step('Adapter A completes the task');
  const done = await ops.complete(d1);
  ctx.check('dialog RECOVERED', done.state === 'RECOVERED' && done.restored, `state=${done.state}, restored=${done.restored}`);
};
