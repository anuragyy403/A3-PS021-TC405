import { LAYER_LABEL, STATE_PLAIN } from './constants.js';

/**
 * Turns the backend's event log (mapped by src/api/mappers.js) into language a
 * first-time viewer can follow without knowing what a dialog_id or a seq is.
 *
 * The raw message stays available behind each feed row as evidence; this
 * module is the single place where it gets translated.
 *
 * Rules are evaluated top to bottom and the first match wins, so the specific
 * patterns have to come before the generic ones. Every rule returns:
 *   tone     - good | warn | bad | info | duplicate, for colour
 *   Icon     - a lucide icon key resolved by the feed
 *   headline - the short sentence shown in the feed
 *   detail   - the supporting sentence, may be null
 */

export const TONE = {
  good: 'good',
  warn: 'warn',
  bad: 'bad',
  info: 'info',
  duplicate: 'duplicate',
};

const seqOf = (entry) => entry.meta?.sequence_no ?? null;
const has = (entry, needle) => String(entry.msg).toLowerCase().includes(needle);

/** True when the entry records a state machine transition (PROCESSING -> ...). */
const isTransition = (entry) => Boolean(entry.meta?.from && entry.meta?.to);

/** True when the entry records Adapter B processing a request (request_processed). */
const isApplied = (entry) => entry.kind === 'success' && /^seq \d+ applied/.test(String(entry.msg));

/* ---- rules keyed on the backend event type ------------------------------
 * Entries produced from backend events carry origin: 'backend' and
 * meta.event_type; dashboard notices (origin: 'dashboard') never match these.
 */
const isBackend = (type) => (entry) => entry.origin === 'backend' && entry.meta?.event_type === type;

const REFUSAL = {
  DIALOG_TERMINAL: 'the task is already finished, so new work is refused',
  TASK_MISMATCH: 'it names a different task than the one on record',
  DIALOG_NOT_FOUND: 'the Receiver Agent does not know this task',
};

const EVENT_RULES = [
  {
    when: isBackend('dialog_recovered'),
    tone: TONE.good,
    Icon: 'recover',
    headline: () => 'Unfinished task reloaded from the SQLite file',
    detail: (entry) => {
      const pending = Array.isArray(entry.meta?.pending_seqs) ? entry.meta.pending_seqs : [];
      const waiting = pending.length ? ` Packet ${pending.join(', ')} still ${pending.length === 1 ? 'needs' : 'need'} an answer.` : '';
      return `Same task, same ids. The next new request gets packet ${entry.meta?.next_seq ?? '?'}.${waiting}`;
    },
  },
  {
    when: isBackend('request_dropped'),
    tone: TONE.bad,
    Icon: 'x',
    headline: (entry) => `Packet ${seqOf(entry)} was lost before reaching the Receiver Agent`,
    detail: () => 'No work was done. The Sender Agent can retry it with the same packet number.',
  },
  {
    when: isBackend('retry_sent'),
    tone: TONE.warn,
    Icon: 'rotate',
    headline: (entry) => `Retrying packet ${seqOf(entry)} (attempt ${entry.meta?.attempts ?? '?'})`,
    detail: () => 'Same task, same packet number, same contents — so the Receiver Agent can tell if it already did this work.',
  },
  {
    when: isBackend('response_dropped'),
    tone: TONE.warn,
    Icon: 'x',
    headline: (entry) => `Reply for packet ${seqOf(entry)} was lost on the way back — the work WAS done`,
    detail: () => 'The Receiver Agent did the work and saved that fact. The Sender Agent never heard back, so it should retry; the retry will be recognised as a duplicate.',
  },
  {
    when: isBackend('response_delivered'),
    tone: TONE.info,
    Icon: 'check',
    headline: (entry) => `Reply for packet ${seqOf(entry)} reached the Sender Agent`,
    detail: (entry) => {
      const status = entry.meta?.status ?? entry.meta?.outcome;
      if (status === 'duplicate') return 'The Receiver Agent answered with the result it had stored the first time.';
      if (status === 'error') return 'The answer was a refusal — no work was done.';
      return 'The work is done and the answer arrived.';
    },
  },
  {
    when: isBackend('request_rejected'),
    tone: TONE.bad,
    Icon: 'shield',
    headline: (entry) => `Packet ${seqOf(entry)} refused — ${REFUSAL[entry.meta?.error_code] ?? 'the Receiver Agent rejected it'}`,
    detail: () => 'No work was done.',
  },
  {
    when: isBackend('request_acked'),
    tone: TONE.good,
    Icon: 'check',
    headline: (entry) => `Packet ${seqOf(entry)} confirmed`,
    detail: () => 'The Sender Agent now knows this work is done and will not need to send it again.',
  },
  {
    when: (entry) => isBackend('adapter_restarted')(entry) && entry.meta?.phase !== 'end',
    tone: TONE.warn,
    Icon: 'rotate',
    headline: (entry) => `Restarting the whole backend process (Adapter ${entry.meta?.target ?? '?'} was asked to restart)`,
    detail: () => 'Both agents share one database file, so both are rebuilt from it. Anything held only in memory is gone; everything saved survives.',
  },
  {
    when: isBackend('adapter_restarted'),
    tone: TONE.good,
    Icon: 'recover',
    headline: () => 'Backend process restarted — both agents reloaded from the saved database',
    detail: () => 'Unfinished tasks are reloaded next, with the same task ids.',
  },
  {
    when: isBackend('runtime_reset'),
    tone: TONE.info,
    Icon: 'rotate',
    headline: () => 'Demo data wiped — starting fresh',
    detail: () => 'The backend deleted its database file and started a new session.',
  },
  {
    when: isBackend('scenario_started'),
    tone: TONE.info,
    Icon: 'sparkles',
    headline: (entry) => `Demo ${entry.meta?.scenario_id} started`,
    detail: (entry) => entry.meta?.title ?? null,
  },
  {
    when: isBackend('scenario_finished'),
    tone: (entry) => (entry.meta?.status === 'passed' ? TONE.good : TONE.bad),
    Icon: 'check',
    headline: (entry) => `Demo ${entry.meta?.scenario_id} ${entry.meta?.status === 'passed' ? 'passed' : 'failed'}`,
    detail: (entry) => (entry.meta?.error ? `Error: ${entry.meta.error}` : entry.meta?.duration_ms !== undefined ? `Took ${entry.meta.duration_ms}ms.` : null),
  },
];

/* ---- rules keyed on the mapped message (mappers.js describe()) ---------- */
const MESSAGE_RULES = [
  {
    when: (entry) => entry.kind === 'duplicate',
    tone: TONE.duplicate,
    Icon: 'copy',
    headline: (entry) => `Duplicate of packet ${seqOf(entry)} blocked`,
    detail: () => 'This work had already been done, so the stored answer was returned instead of running it again.',
  },
  {
    when: isApplied,
    tone: TONE.good,
    Icon: 'check',
    headline: (entry) => `Packet ${seqOf(entry)} received and processed`,
    detail: (entry) => {
      const done = entry.meta?.side_effects;
      return typeof done === 'number' && done > 0 ? `Work item ${done} completed. A retried copy would not be applied again.` : 'Completed. A retried copy would not be applied again.';
    },
  },
  {
    when: isTransition,
    tone: (entry) => (entry.meta?.to === 'FAILED' ? TONE.bad : entry.meta?.to === 'RECOVERED' ? TONE.good : TONE.info),
    Icon: 'task',
    headline: (entry) => `Task is now: ${STATE_PLAIN[entry.meta.to]?.label ?? entry.meta.to}`,
    detail: (entry) => entry.meta?.reason ?? null,
  },
  {
    when: (entry) => entry.kind === 'success' && has(entry, 'dialog opened'),
    tone: TONE.info,
    Icon: 'task',
    headline: () => 'New task started',
    detail: (entry) => (entry.meta?.task_id ? `Reference ${entry.meta.task_id}` : null),
  },
  {
    when: (entry) => entry.kind === 'success' && has(entry, 'dispatch seq'),
    tone: TONE.info,
    Icon: 'send',
    headline: (entry) => `Sending packet ${seqOf(entry)} to the Receiver Agent`,
    detail: () => null,
  },
];

const RULES = [...EVENT_RULES, ...MESSAGE_RULES];

/**
 * @param {object} entry a feed entry (mappers.js mapEventToLog / noticeLog)
 * @returns {{tone: string, Icon: string, headline: string, detail: string|null, source: string}}
 */
export function narrate(entry) {
  for (const rule of RULES) {
    let matched = false;
    try {
      matched = rule.when(entry);
    } catch {
      matched = false;
    }
    if (!matched) continue;

    const rawTone = typeof rule.tone === 'function' ? rule.tone(entry) : rule.tone;
    let headline = '';
    try {
      headline = rule.headline(entry);
    } catch {
      headline = String(entry.msg);
    }

    let detail = null;
    try {
      detail = rule.detail(entry) ?? null;
    } catch {
      detail = null;
    }

    return {
      tone: rawTone ?? TONE.info,
      Icon: rule.Icon,
      headline: headline || String(entry.msg),
      detail,
      source: LAYER_LABEL[entry.layer] ?? 'System',
    };
  }

  return {
    tone: TONE.info,
    Icon: 'info',
    headline: String(entry.msg),
    detail: null,
    source: LAYER_LABEL[entry.layer] ?? 'System',
  };
}

/** One-line summary of a task's progress, used by the task list. */
export function describeTask(dialog) {
  const count = dialog.sideEffects;
  if (dialog.state === 'FAILED') return 'Stopped before finishing — the retry limit was reached or it was aborted';
  if (dialog.state === 'COMMITTED') return `All ${count} work items completed, none repeated`;
  if (dialog.state === 'RECOVERED') return `Finished after a restart — ${count} work items, none repeated`;
  if (dialog.state === 'INITIATED') return 'Created, waiting for the first request';
  return `${count} work item${count === 1 ? '' : 's'} completed so far`;
}
