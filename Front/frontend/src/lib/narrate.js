import { LAYER_LABEL, STATE_PLAIN } from './constants.js';

/**
 * Turns the engine's precise audit log into language a faculty member can follow
 * without knowing what a sequence number or a write-ahead log is.
 *
 * The engine deliberately keeps writing in protocol terms: that log is evidence.
 * This module is the single place where those terms get translated, so the rest
 * of the interface never has to think about `seq`, `NACK`, `WAL` or rehydration.
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
const annotationsOf = (entry) => (Array.isArray(entry.meta?.annotations) ? entry.meta.annotations : []);

/** True when the entry records a state machine transition (PROCESSING -> ...). */
const isTransition = (entry) => Boolean(entry.meta?.from && entry.meta?.to);

/** True when the entry records a frame being applied to the side-effect ledger. */
const isApplied = (entry) => entry.kind === 'success' && /^seq \d+ applied/.test(String(entry.msg));

/** "packet 2 and 3" from a missing window array. */
function windowList(window) {
  if (!Array.isArray(window) || !window.length) return null;
  if (window.length === 1) return `packet ${window[0]}`;
  if (window.length === 2) return `packets ${window[0]} and ${window[1]}`;
  return `packets ${window[0]} to ${window[window.length - 1]}`;
}

/* ---- backend-only rules (Phase 7b) -------------------------------------
 * Entries produced from backend events by src/api/mappers.js carry
 * origin: 'backend' and meta.event_type.  These rules match ONLY those entries,
 * so narration of the browser simulation is untouched.
 */
const isBackend = (type) => (entry) => entry.origin === 'backend' && entry.meta?.event_type === type;

const REFUSAL = {
  DIALOG_TERMINAL: 'the task is already finished, so new work is refused',
  TASK_MISMATCH: 'it names a different task than the one on record',
  DIALOG_NOT_FOUND: 'the Receiver Agent does not know this task',
};

const BACKEND_RULES = [
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

const RULES = [
  /* ---- packets getting lost ------------------------------------------ */
  {
    when: (entry) => entry.kind === 'error' && has(entry, 'blackholed'),
    tone: TONE.bad,
    Icon: 'x',
    headline: (entry) => `Packet ${seqOf(entry)} was lost on the way`,
    detail: () => 'The network dropped this packet. The receiver will notice the gap and ask for it again.',
  },
  {
    when: (entry) => entry.kind === 'error' && has(entry, 'dropped in transit'),
    tone: TONE.bad,
    Icon: 'x',
    headline: (entry) => `Packet ${seqOf(entry)} was lost — the connection broke`,
    detail: () => 'The network link failed, so this packet never arrived.',
  },
  {
    when: (entry) => entry.kind === 'error' && has(entry, 'unrecoverable'),
    tone: TONE.bad,
    Icon: 'x',
    headline: (entry) => {
      const subject = windowList(entry.meta?.missing_window) ?? 'the missing packet';
      return `Could not get ${subject} back after 3 tries`;
    },
    detail: () => 'The task is marked as failed, so nobody is told it succeeded when it did not.',
  },
  {
    when: (entry) => entry.kind === 'error' && entry.layer === 'bridge' && has(entry, 'partition'),
    tone: TONE.bad,
    Icon: 'x',
    headline: () => 'The network connection broke',
    detail: (entry) => `Anything sent right now, starting with packet ${entry.meta?.sequence_no ?? '?'}, will be lost.`,
  },

  /* ---- crashes and recovery ------------------------------------------- */
  {
    when: (entry) => entry.kind === 'error' && has(entry, 'sigkill'),
    tone: TONE.bad,
    Icon: 'crash',
    headline: () => 'The Sender Agent crashed',
    detail: (entry) =>
      entry.meta?.persisted_snapshot
        ? 'Its memory was wiped, but this task was safely saved in the database.'
        : 'Its memory was wiped and this task was lost.',
  },
  {
    when: (entry) => entry.kind === 'recovery' && has(entry, 'rehydrated'),
    tone: TONE.good,
    Icon: 'recover',
    headline: () => 'Unfinished task reloaded from the database',
    detail: (entry) => `Picking up exactly where it stopped, at packet ${entry.meta?.next_sequence ?? '?'}.`,
  },
  {
    when: (entry) => entry.kind === 'success' && entry.layer === 'control' && has(entry, 'restarting'),
    tone: TONE.info,
    Icon: 'rotate',
    headline: () => 'Restarting the Sender Agent',
    detail: () => 'It is booting up and reloading anything it left unfinished.',
  },
  {
    when: (entry) => entry.kind === 'success' && entry.layer === 'control' && has(entry, 'online'),
    tone: TONE.good,
    Icon: 'recover',
    headline: () => 'Sender Agent is back online',
    detail: (entry) => {
      const count = entry.meta?.rehydrated;
      if (typeof count !== 'number' || count < 1) return 'Everything is connected again.';
      return `${count} unfinished task${count === 1 ? '' : 's'} restored automatically.`;
    },
  },

  /* ---- gaps and re-transmission --------------------------------------- */
  {
    when: (entry) => entry.kind === 'recovery' && has(entry, 'nack'),
    tone: TONE.warn,
    Icon: 'alert',
    headline: (entry) => {
      const subject = windowList(entry.meta?.missing_window);
      if (!subject) return 'A gap was detected — asking for the missing packets';
      return `Missing ${subject} — asking the sender to send ${subject.split(' ').length > 1 ? 'them' : 'it'} again`;
    },
    detail: (entry) => {
      const attempts = entry.meta?.attempts;
      const held = Array.isArray(entry.meta?.buffered) && entry.meta.buffered.length ? ` Packet ${entry.meta.buffered.join(', ')} ${entry.meta.buffered.length > 1 ? 'are' : 'is'} held safely meanwhile.` : '';
      return typeof attempts === 'number' ? `Resend attempt ${attempts} of 3.${held}` : held.trim() || null;
    },
  },
  {
    when: (entry) => entry.kind === 'recovery' && has(entry, 'rto fired'),
    tone: TONE.warn,
    Icon: 'resend',
    headline: (entry) => `No confirmation for packet ${seqOf(entry)} — sending it again`,
    detail: (entry) => `Resend attempt ${entry.meta?.attempts ?? 1} of 3.`,
  },
  {
    when: (entry) => entry.kind === 'recovery' && has(entry, 'commit withheld'),
    tone: TONE.warn,
    Icon: 'alert',
    headline: () => 'Not finishing the task yet',
    detail: () => 'A packet is still missing, so the task is not marked as complete.',
  },
  {
    when: (entry) => entry.kind === 'error' && has(entry, 'illegal transition'),
    tone: TONE.bad,
    Icon: 'shield',
    headline: () => 'A safety rule blocked an invalid step',
    detail: (entry) => `A task cannot go straight from "${STATE_PLAIN[entry.meta?.from]?.label ?? entry.meta?.from}" to "${STATE_PLAIN[entry.meta?.to]?.label ?? entry.meta?.to}".`,
  },

  /* ---- duplicates ------------------------------------------------------ */
  {
    when: (entry) => entry.kind === 'duplicate',
    tone: TONE.duplicate,
    Icon: 'copy',
    headline: (entry) => `Duplicate of packet ${seqOf(entry)} blocked`,
    detail: (entry) =>
      entry.meta?.digest_match === false
        ? 'This claimed to be a repeat but its contents had changed, so it was rejected anyway.'
        : 'This work had already been done, so it was skipped instead of repeated.',
  },

  /* ---- re-ordering ----------------------------------------------------- */
  {
    when: (entry) => entry.kind === 'recovery' && has(entry, 'buffered'),
    tone: TONE.warn,
    Icon: 'hold',
    headline: (entry) => `Packet ${seqOf(entry)} arrived early — holding it back`,
    detail: (entry) =>
      `The receiver is still waiting for packet ${entry.meta?.expected_sequence ?? '?'}, so this one waits its turn.`,
  },
  {
    when: (entry) => entry.kind === 'recovery' && has(entry, 'shim reordering'),
    tone: TONE.warn,
    Icon: 'shuffle',
    headline: (entry) =>
      `The network delivered packets ${entry.meta?.sequence_no ?? '?'} and ${entry.meta?.expected_sequence ?? '?'} in the wrong order`,
    detail: () => 'This happens on real networks, and the receiver is built to handle it.',
  },
  {
    when: (entry) => entry.kind === 'recovery' && has(entry, 'holding seq'),
    tone: TONE.warn,
    Icon: 'hold',
    headline: (entry) => `Packet ${seqOf(entry)} is taking longer to arrive`,
    detail: (entry) => `Held back by the network for ${entry.meta?.delay_ms ?? 0}ms to simulate a slow link.`,
  },

  /* ---- successful work -------------------------------------------------- */
  {
    when: isApplied,
    tone: TONE.good,
    Icon: 'check',
    headline: (entry) => `Packet ${seqOf(entry)} received and processed`,
    detail: (entry) => {
      const notes = annotationsOf(entry);
      if (notes.some((note) => note.includes('released from reorder buffer'))) {
        return 'This was the packet that was held back. It has now been put into the correct order.';
      }
      if (notes.some((note) => note.includes('re-transmission'))) {
        return 'This is the copy that was requested earlier. The work was still only done once.';
      }
      const done = entry.meta?.side_effects;
      return typeof done === 'number' && done > 0 ? `Work item ${done} completed. A retried copy would not be applied again.` : 'Completed. A retried copy would not be applied again.';
    },
  },
  {
    when: (entry) => entry.kind === 'success' && entry.layer === 'sqlite',
    tone: TONE.info,
    Icon: 'save',
    headline: () => 'Progress saved to the database',
    detail: (entry) =>
      entry.meta?.durability === 'fsync'
        ? 'This task is safely stored, so the sender could pick it up again after a crash.'
        : 'A checkpoint was saved so that a crash would be recoverable.',
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
    detail: (entry) => (entry.meta?.out_of_order ? 'Sent deliberately out of order.' : null),
  },
];

/**
 * @param {object} entry a log entry from the engine
 * @returns {{tone: string, Icon: string, headline: string, detail: string|null, source: string}}
 */
export function narrate(entry) {
  for (const rule of entry?.origin === 'backend' ? [...BACKEND_RULES, ...RULES] : RULES) {
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
  if (dialog.state === 'FAILED') {
    if (!dialog.missing?.length) return 'Stopped before finishing — the retry limit was reached or it was aborted';
    return `Could not finish — packet${dialog.missing.length > 1 ? 's' : ''} ${dialog.missing.join(', ')} never arrived`;
  }
  if (dialog.state === 'COMMITTED') return `All ${count} work items completed, none repeated`;
  if (dialog.state === 'RECOVERED') return `Finished after a crash — ${count} work items, none repeated`;
  if (dialog.state === 'WAITING_ACK') return 'All work done — waiting for confirmation';
  if (dialog.state === 'INITIATED') return 'Created, waiting for the first packet';
  if (dialog.buffered.length) {
    return `Holding packet${dialog.buffered.length > 1 ? 's' : ''} ${dialog.buffered.join(', ')} while waiting for packet ${dialog.nextSeq}`;
  }
  return `${count} work item${count === 1 ? '' : 's'} completed so far`;
}
