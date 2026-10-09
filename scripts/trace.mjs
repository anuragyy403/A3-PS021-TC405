#!/usr/bin/env node
/**
 * Trace view (PS-021 Phase 10).  Plain Node (fetch), no dependencies.
 *
 *   node scripts/trace.mjs                 new events only
 *   node scripts/trace.mjs --from-start    the whole retained event log first
 *   node scripts/trace.mjs --url http://localhost:3101   (or BACKEND_URL=…)
 *   node scripts/trace.mjs --no-time       without the clock column
 *
 * Polls GET /api/events?since=<cursor> and prints one readable line per backend
 * event (backend/src/runtime/EventLog.ts EVENT_TYPES).  Follows epoch changes
 * (reset, or a new backend process), reports evicted events, and keeps retrying
 * while the backend is unreachable.  Unknown event types are printed raw.
 */
import { pathToFileURL } from 'node:url';

const pad2 = (n) => String(n).padStart(2, '0');

function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--.---';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** dlg-1791513133981-4jm8dmo → dlg-…4jm8dmo (the random suffix is unique enough to follow by eye). */
export function shortId(id) {
  if (!id) return '?';
  const m = /^dlg-\d+-(\w+)$/.exec(id);
  return m ? `dlg-…${m[1]}` : id;
}

const list = (xs) => `[${(Array.isArray(xs) ? xs : []).join(',')}]`;

/** event type → [actor label, text] (null = print nothing). */
const FORMAT = {
  dialog_created: (e) => ['A', `startDialog task_id=${e.task_id} → dialog_id=${e.dialog_id} INITIATED`],
  request_sent: (e) => ['A', `send seq=${e.seq} → send log PENDING   (${shortId(e.dialog_id)})`],
  retry_sent: (e) => ['A', `retry seq=${e.seq} (attempt ${e.details?.attempts ?? '?'}) — same dialog_id, task_id, seq and stored payload   (${shortId(e.dialog_id)})`],
  request_dropped: (e) => ['net', `request for seq ${e.seq} LOST — B never saw it   (${shortId(e.dialog_id)})`],
  request_processed: (e) => ['B', `(${shortId(e.dialog_id)},${e.seq}) new → processed (processed_count=${e.details?.processed_count ?? '?'})`],
  duplicate_suppressed: (e) => ['B', `(${shortId(e.dialog_id)},${e.seq}) already processed → DUPLICATE, work NOT repeated, stored answer returned${e.details?.terminal ? ' (dialog finished)' : ''}`],
  request_rejected: (e) => ['B', `(${shortId(e.dialog_id)},${e.seq}) REJECTED ${e.details?.error_code ?? ''} — no work done`.trim()],
  response_delivered: (e) => ['net', `reply for seq ${e.seq} delivered to A (status ${e.details?.status ?? e.outcome})   (${shortId(e.dialog_id)})`],
  response_dropped: (e) => ['net', `reply for seq ${e.seq} LOST — B already did the work (B status ${e.details?.b_status ?? '?'})   (${shortId(e.dialog_id)})`],
  request_acked: (e) => ['A', `seq ${e.seq} acknowledged → send log ACKED   (${shortId(e.dialog_id)})`],
  state_transition: (e) => [e.actor === 'B' ? 'B' : 'A', `${shortId(e.dialog_id)} ${e.details?.from} → ${e.details?.to}${e.details?.reason ? ` (${e.details.reason})` : ''}`],
  adapter_restarted: (e) => ['rt', e.details?.phase === 'end'
    ? 'restart complete — both adapters rebuilt from the SQLite file'
    : `PROCESS RESTART (target ${e.details?.target ?? '?'}) — both adapters rebuilt from the SQLite file`],
  dialog_recovered: (e) => ['A', `recovered ${e.dialog_id} task_id=${e.task_id} state=${e.details?.state} next_seq=${e.details?.next_seq} pending=${list(e.details?.pending_seqs)}`],
  runtime_reset: (e) => ['rt', `RESET — database wiped, new epoch ${e.details?.epoch ?? ''}`.trim()],
  scenario_started: (e) => ['demo', `${e.details?.title ?? `Scenario ${e.details?.scenario_id}`} — started${e.details?.variant ? ` (variant ${e.details.variant})` : ''}`],
  scenario_step: (e) => ['demo', `  ${e.details?.text ?? ''}`],
  // Each check is also emitted as a "PASS · …"/"FAIL · …" step, so only failures are repeated here.
  scenario_assertion: (e) => (e.details?.ok ? null : ['demo', `  ✗ ${e.details?.label}${e.details?.detail ? ` — ${e.details.detail}` : ''}`]),
  scenario_finished: (e) => ['demo', `Scenario ${e.details?.scenario_id} ${String(e.details?.status ?? '').toUpperCase()} in ${e.details?.duration_ms ?? '?'} ms${e.details?.error ? ` — ${e.details.error}` : ''}`],
};

export const FORMATTED_TYPES = Object.keys(FORMAT);

/**
 * Events → printable lines.  A B-side INITIATED → PROCESSING transition that
 * directly follows the request it was caused by is folded into that line.
 */
export function formatEvents(events, { time = true } = {}) {
  const lines = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const fmt = FORMAT[e?.type];
    let label;
    let text;
    if (!fmt) {
      [label, text] = ['?', JSON.stringify(e)];
    } else {
      const out = fmt(e);
      if (!out) continue;
      [label, text] = out;
      const next = events[i + 1];
      if (e.type === 'request_processed' && next?.type === 'state_transition' && next.actor === 'B'
        && next.dialog_id === e.dialog_id && next.seq === e.seq) {
        text += `; ${next.details?.from} → ${next.details?.to}`;
        i += 1;
      }
    }
    lines.push(`${time ? `${clock(e?.at)} ` : ''}${`[${label}]`.padEnd(7)}${text}`);
  }
  return lines;
}

// ---------------------------------------------------------------- live follow
async function main() {
  const argv = process.argv.slice(2);
  const urlAt = argv.indexOf('--url');
  const base = (urlAt !== -1 ? argv[urlAt + 1] : process.env.BACKEND_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
  const fromStart = argv.includes('--from-start');
  const time = !argv.includes('--no-time');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const note = (text) => process.stdout.write(`${time ? `${clock(new Date().toISOString())} ` : ''}[trace] ${text}\n`);
  const getJson = async (path) => {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return res.json();
  };

  let cursor = null;
  let epoch = null;
  let down = false;
  process.on('SIGINT', () => process.exit(0));
  note(`following ${base}${fromStart ? ' from the start of its event log' : ' (new events only; --from-start for history)'} — Ctrl+C to stop`);

  for (;;) {
    let more = false;
    try {
      if (cursor === null) {
        if (fromStart) {
          cursor = 0;
        } else {
          const state = await getJson('/api/state');
          cursor = state.runtime.cursor;
          epoch = state.runtime.epoch;
        }
      }
      const page = await getJson(`/api/events?since=${cursor}&limit=500`);
      if (down) {
        note(`backend reachable again at ${base}`);
        down = false;
      }
      if (epoch !== null && page.epoch !== epoch) {
        note(`new event log (epoch ${page.epoch}): the backend was reset or is a new process — reading it from its start`);
        epoch = page.epoch;
        cursor = Math.max(0, page.oldest_available - 1);
        continue;
      }
      epoch = page.epoch;
      if (page.truncated) {
        note(`events after #${cursor} were evicted from the backend's in-memory buffer — continuing from #${page.oldest_available}`);
        cursor = Math.max(0, page.oldest_available - 1);
        continue;
      }
      for (const line of formatEvents(page.events, { time })) process.stdout.write(`${line}\n`);
      cursor = page.cursor;
      more = page.events.length >= 500;
    } catch (error) {
      if (!down) {
        note(`backend unreachable at ${base} (${error.cause?.code ?? error.message}) — retrying…`);
        down = true;
      }
    }
    if (!more) await sleep(down ? 1000 : 300);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
