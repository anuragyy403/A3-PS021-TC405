import { useMemo, useState } from 'react';
import { Pill } from './ui/Glass.jsx';
import { TONE_CLASSES } from './ui/tokens.js';
import { STATE_PLAIN } from '../lib/constants.js';

/**
 * Manual controls for the live backend (Phase 7b).
 *
 * Every button is exactly one API call through engine.actions — nothing is
 * retried or healed automatically.  Actions apply to the task selected in the
 * Tasks list.  Restart A and Restart B both restart the whole backend process
 * from the SQLite file (both adapters share one store), which the panel says.
 */

const FAULTS = [
  { id: '', label: 'No fault' },
  { id: 'drop_request', label: 'Lose the request' },
  { id: 'drop_response', label: 'Lose the reply' },
];

const newTaskId = () => `task-${Date.now().toString(36).slice(-6)}`;

function FaultPicker({ value, onChange, disabled, label }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={label}>
      {FAULTS.map((fault) => {
        const active = value === fault.id;
        return (
          <button
            key={fault.id || 'none'}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(fault.id)}
            className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40 ${
              active
                ? fault.id ? `${TONE_CLASSES.bad.border} ${TONE_CLASSES.bad.bg} ${TONE_CLASSES.bad.text}` : 'border-white/20 bg-white/[0.08] text-white'
                : 'border-white/[0.07] bg-white/[0.02] text-slate-400 hover:text-slate-200'
            }`}
          >
            {fault.label}
          </button>
        );
      })}
    </div>
  );
}

export default function ManualControls({ actions, dialogs, selectedId, onSelect, busy, connected }) {
  const [taskId, setTaskId] = useState(newTaskId);
  const [fault, setFault] = useState('');
  const [retrySeq, setRetrySeq] = useState('');
  const [retryFault, setRetryFault] = useState('');
  const [reason, setReason] = useState('aborted by operator');
  const [result, setResult] = useState(null);       // { ok, message }
  const [recovered, setRecovered] = useState(null); // RestartResult.recovered

  const selected = dialogs.find((dialog) => dialog.id === selectedId) ?? null;

  /** Sent seqs, unanswered first, then newest first. */
  const retryOptions = useMemo(() => {
    if (!selected) return [];
    const pending = new Set(selected.pendingSeqs ?? []);
    return [...selected.ledger]
      .sort((a, b) => Number(pending.has(b.seq)) - Number(pending.has(a.seq)) || b.seq - a.seq)
      .map((row) => ({ seq: row.seq, pending: pending.has(row.seq) }));
  }, [selected]);

  const lastAcked = useMemo(() => {
    if (!selected) return null;
    const acked = selected.ledger.filter((row) => row.backendStatus === 'acked').map((row) => row.seq);
    return acked.length ? Math.max(...acked) : null;
  }, [selected]);

  const chosenSeq = retryOptions.some((o) => String(o.seq) === retrySeq) ? Number(retrySeq) : retryOptions[0]?.seq ?? null;

  const blocked = busy || !connected;
  const finished = Boolean(selected?.settled);
  const canNew = !blocked && taskId.trim().length > 0;
  const canWork = !blocked && selected !== null && !finished;   // send / complete / abort
  const canRetry = !blocked && chosenSeq !== null;                // allowed on finished tasks (idempotent replay)
  const canDuplicate = !blocked && lastAcked !== null;

  let hint = null;
  if (!connected) hint = 'The backend is not reachable — controls are paused until it is back.';
  else if (busy) hint = 'Busy — a demo or another action is running on the backend. Controls unlock when it finishes.';
  else if (!selected) hint = 'Select a task in the Tasks list below, or create a new one.';
  else if (finished) {
    hint = `This task is finished (${STATE_PLAIN[selected.state]?.label ?? selected.state}). New requests, complete and abort are disabled; retrying a packet it already sent is still allowed — the receiver just returns its stored answer.`;
  }

  async function run(action, after) {
    const outcome = await action();
    setResult({ ok: outcome.ok, message: outcome.message });
    if (outcome.ok && after) after(outcome.result);
  }

  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="overline">Try it yourself — on the live backend</p>
        <p className="text-[12px] text-slate-500">Each button is one request to the backend. Nothing is retried for you.</p>
      </div>

      {/* new task + selection */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-1.5">
          <span className="text-[12px] text-slate-500">task_id</span>
          <input
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            maxLength={128}
            className="w-40 bg-transparent font-mono text-[12.5px] text-white outline-none"
            aria-label="Task id for the new task"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={!canNew}
          onClick={() => run(() => actions.createTask(taskId.trim()), (r) => { onSelect(r.dialog.dialog_id); setTaskId(newTaskId()); })}
        >
          New task
        </button>
        <span className="ml-1 text-[12px] text-slate-500">Selected:</span>
        {selected ? (
          <Pill tone={finished ? 'idle' : 'info'}>
            <span className="font-mono">{selected.id}</span> · {selected.taskId} · {STATE_PLAIN[selected.state]?.label ?? selected.state}
          </Pill>
        ) : (
          <Pill tone="idle">none</Pill>
        )}
      </div>

      {/* send */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-[12px] font-semibold text-slate-400">Send next</span>
        <FaultPicker value={fault} onChange={setFault} disabled={!canWork} label="Fault for the next request" />
        <button type="button" className="btn-ghost" disabled={!canWork} onClick={() => run(() => actions.send(selected.id, fault))}>
          Send seq {selected?.nextSeq ?? '–'}
        </button>
      </div>

      {/* retry + duplicate */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-[12px] font-semibold text-slate-400">Retry</span>
        <select
          value={chosenSeq ?? ''}
          onChange={(event) => setRetrySeq(event.target.value)}
          disabled={!canRetry}
          className="rounded-lg border border-white/[0.07] bg-night-950 px-2 py-1.5 text-[12.5px] text-slate-200 disabled:opacity-40"
          aria-label="Packet to retry"
        >
          {retryOptions.length === 0 ? <option value="">nothing sent yet</option> : null}
          {retryOptions.map((o) => (
            <option key={o.seq} value={o.seq}>
              seq {o.seq}{o.pending ? ' · no answer yet' : ' · answered'}
            </option>
          ))}
        </select>
        <FaultPicker value={retryFault} onChange={setRetryFault} disabled={!canRetry} label="Fault for the retry" />
        <button type="button" className="btn-ghost" disabled={!canRetry} onClick={() => run(() => actions.retry(selected.id, chosenSeq, retryFault))}>
          Retry seq {chosenSeq ?? '–'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!canDuplicate}
          title="A duplicate is the same (dialog_id, seq) sent again — here the last packet that was already answered."
          onClick={() => run(() => actions.retry(selected.id, lastAcked, ''))}
        >
          Send duplicate of seq {lastAcked ?? '–'}
        </button>
      </div>
      <p className="-mt-2 pl-[6.5rem] text-[11.5px] text-slate-500">
        A duplicate is the same task and packet number (dialog_id, seq) sent again; the receiver must not repeat the work.
      </p>

      {/* finish */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-[12px] font-semibold text-slate-400">Finish</span>
        <button type="button" className="btn-ghost" disabled={!canWork} onClick={() => run(() => actions.complete(selected.id))}>
          Complete task
        </button>
        <label className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-1.5">
          <span className="text-[12px] text-slate-500">reason</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            className="w-40 bg-transparent text-[12.5px] text-white outline-none"
            aria-label="Reason for aborting"
          />
        </label>
        <button type="button" className="btn-ghost" disabled={!canWork || !reason.trim()} onClick={() => run(() => actions.abort(selected.id, reason.trim()))}>
          Abort task
        </button>
      </div>

      {/* restart */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-[12px] font-semibold text-slate-400">Restart</span>
        {['A', 'B'].map((adapter) => (
          <button
            key={adapter}
            type="button"
            className="btn-ghost"
            disabled={blocked}
            onClick={() => run(() => actions.restart(adapter), (r) => setRecovered(r.recovered))}
          >
            Restart Adapter {adapter}
          </button>
        ))}
        <span className="text-[11.5px] text-slate-500">
          Either button restarts the whole backend process: both adapters share one SQLite file and are rebuilt from it.
        </span>
      </div>

      {hint ? <p className="text-[12px] text-amber-300/90" data-testid="manual-hint">{hint}</p> : null}

      {result ? (
        <p
          role="status"
          className={`rounded-xl border px-3.5 py-2.5 font-mono text-[12px] ${
            result.ok ? `${TONE_CLASSES.info.border} ${TONE_CLASSES.info.bg} text-sky-100` : `${TONE_CLASSES.bad.border} ${TONE_CLASSES.bad.bg} text-rose-100`
          }`}
        >
          {result.message}
        </p>
      ) : null}

      {recovered ? (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-[12px] text-slate-300" data-testid="manual-recovered">
          <p className="overline mb-1.5">Reloaded after the last restart</p>
          {recovered.length === 0 ? (
            <p className="text-slate-500">No unfinished tasks had to be reloaded.</p>
          ) : (
            <ul className="space-y-1 font-mono text-[11.5px]">
              {recovered.map((r) => (
                <li key={r.dialog_id}>
                  {r.dialog_id} · {r.task_id} · {r.state} · next_seq {r.next_seq} · no answer yet: [{r.pending_seqs.join(', ')}]
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
