/**
 * Scenario 5 — Mid-Task Disconnect + Adapter A Restart → Resume
 * Mirrors tests/scenarios.test.ts (Scenario 5, both variants).
 *
 *   response_lost (default): seq 3 processed by B, response lost → retry is a duplicate
 *   request_lost:            seq 3 never reached B            → retry is processed
 */

import type { ScenarioScript } from './types.js';

export const scenario5: ScenarioScript = async (ops, ctx, { variant, read }) => {
  const responseLost = variant === 'response_lost';

  ctx.step(`Create D1/T1 (variant: ${variant})`, 'head');
  const t1 = ctx.taskId('T1');
  const d1 = (await ops.startDialog(t1)).dialog_id;

  ctx.step('Send seq 1 and seq 2');
  const s1 = await ops.send(d1, { step: 1 });
  const s2 = await ops.send(d1, { step: 2 });
  ctx.check('seq 1 and 2 processed', s1.outcome === 'ok' && s2.outcome === 'ok', `${s1.outcome}, ${s2.outcome}`);
  await ctx.pause();

  ctx.step(responseLost
    ? 'Send seq 3 — B processes it, the response is lost; Adapter A goes down'
    : 'Send seq 3 — the request is lost; Adapter A goes down', 'warn');
  const s3 = await ops.send(d1, { step: 3 }, responseLost ? 'drop_response' : 'drop_request');
  const expectedBefore = responseLost ? 3 : 2;
  ctx.check(responseLost ? 'response dropped, B processed seq 3' : 'request dropped, B never saw seq 3',
    s3.delivery === (responseLost ? 'response_dropped' : 'request_dropped') && s3.dialog.processed_count === expectedBefore,
    `delivery=${s3.delivery}, processed_count=${s3.dialog.processed_count}`);
  await ctx.pause();

  ctx.step('Restart Adapter A (process restart) and recover from the file', 'warn');
  const restart = await ops.restart('A');
  const rec = restart.recovered.find(r => r.dialog_id === d1);
  ctx.check('same dialog and task recovered', rec !== undefined && rec.task_id === t1, rec ? `state=${rec.state}` : 'not recovered');
  ctx.check('in-flight seq 3 reported, next_seq 4', rec?.pending_seqs.join(',') === '3' && rec?.next_seq === 4,
    `pending=[${rec?.pending_seqs}], next_seq=${rec?.next_seq}`);
  ctx.check('dialog marked restored', read.getDialog(d1).dialog.restored, `restored=${read.getDialog(d1).dialog.restored}`);
  await ctx.pause();

  ctx.step('Retry in-flight seq 3');
  const r3 = await ops.retry(d1, 3);
  if (responseLost) {
    ctx.check('seq 3 retry is a duplicate', r3.outcome === 'duplicate', `outcome=${r3.outcome}`);
    ctx.step('Retry already-processed seq 1');
    const r1 = await ops.retry(d1, 1);
    ctx.check('seq 1 retry is a duplicate', r1.outcome === 'duplicate', `outcome=${r1.outcome}`);
    ctx.check('no side effect re-run after restart', read.getDialog(d1).dialog.side_effects_since_boot === 0,
      `side_effects_since_boot=${read.getDialog(d1).dialog.side_effects_since_boot}`);
  } else {
    ctx.check('seq 3 retry processed (first arrival)', r3.outcome === 'ok', `outcome=${r3.outcome}`);
    ctx.check('seq 3 processed once', read.getDialog(d1).dialog.side_effects_since_boot === 1,
      `side_effects_since_boot=${read.getDialog(d1).dialog.side_effects_since_boot}`);
  }
  await ctx.pause();

  ctx.step('Continue the same task with the next request');
  const s4 = await ops.send(d1, { step: 4 });
  ctx.check('next request gets seq 4 from durable state', s4.outcome === 'ok' && s4.seq === 4, `seq=${s4.seq}, outcome=${s4.outcome}`);
  ctx.check('same dialog_id / task_id', s4.dialog_id === d1 && s4.task_id === t1, 'unchanged');
  const sinceBoot = read.getDialog(d1).dialog.side_effects_since_boot;
  ctx.check('side effects since restart as expected', sinceBoot === (responseLost ? 1 : 2), `side_effects_since_boot=${sinceBoot}`);
  ctx.check('only one dialog for the task', read.listDialogs().filter(d => d.task_id === t1).length === 1, 'no new dialog created');
  await ctx.pause();

  ctx.step('Adapter A completes the task');
  const done = await ops.complete(d1);
  ctx.check('dialog RECOVERED', done.state === 'RECOVERED' && done.restored, `state=${done.state}, restored=${done.restored}`);
};
