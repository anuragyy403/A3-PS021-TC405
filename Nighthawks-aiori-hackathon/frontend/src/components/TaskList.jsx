import { useState } from 'react';
import { STATE_PLAIN, STATE_STYLE } from '../lib/constants.js';
import { describeTask } from '../lib/narrate.js';
import { Empty, IconTile } from './ui/Glass.jsx';
import { TONE_CLASSES } from './ui/tokens.js';

/** Maps a lifecycle state onto one of the interface's semantic tones. */
function toneForState(state) {
  if (state === 'COMMITTED') return 'good';
  if (state === 'RECOVERED') return 'info';
  if (state === 'FAILED') return 'bad';
  if (state === 'WAITING_ACK') return 'warn';
  if (state === 'PROCESSING') return 'info';
  return 'idle';
}

/** Tiny strip showing, packet by packet, what has happened to a task. */
function PacketStrip({ ledger }) {
  const STYLE = {
    applied: { cls: 'bg-emerald-400', label: 'processed' },
    buffered: { cls: 'bg-amber-400', label: 'held, waiting for an earlier packet' },
    missing: { cls: 'bg-rose-400', label: 'lost, being requested again' },
    pending: { cls: 'bg-slate-700', label: 'not sent yet' },
  };

  return (
    <div className="flex items-center gap-1" title="Each square is one packet, in order">
      {ledger.map((row) => (
        <span
          key={row.seq}
          title={`Packet ${row.seq}: ${STYLE[row.status]?.label ?? row.status}`}
          className={`h-2.5 w-2.5 rounded-[3px] ${STYLE[row.status]?.cls ?? 'bg-slate-700'} transition-colors duration-300`}
        />
      ))}
    </div>
  );
}

/**
 * Every task the system knows about.
 *
 * Replaces the old correlation registry: the same information, but framed as
 * "what is this task and how far along is it" rather than raw dialog identifiers
 * and write-ahead-log offsets.
 */
export default function TaskList({ dialogs, selectedId, onSelect }) {
  const [showFinished, setShowFinished] = useState(true);

  const visible = dialogs.filter((dialog) => showFinished || !dialog.settled);
  const running = dialogs.filter((dialog) => !dialog.settled).length;

  return (
    <section className="glass flex min-h-0 flex-col overflow-hidden">
      <span className="glass-sheen" aria-hidden="true" />

      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pb-3 pt-5">
        <IconTile name="tasks" tone={running ? 'info' : 'idle'} size="md" pulse={running > 0} />
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-white">Tasks</h2>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            {running ? `${running} in progress` : dialogs.length ? 'Everything has finished' : 'Nothing has been sent yet'}
          </p>
        </div>
        {dialogs.length ? (
          <button
            type="button"
            onClick={() => setShowFinished((value) => !value)}
            className="ml-auto rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-[11.5px] font-semibold text-slate-400 transition hover:border-white/15 hover:text-slate-200"
          >
            {showFinished ? 'Hide finished' : 'Show finished'}
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {visible.length === 0 ? (
          <Empty
            icon="tasks"
            title={dialogs.length ? 'No tasks in progress' : 'No tasks yet'}
            hint={
              dialogs.length
                ? 'Every task has finished. Switch back on to review them.'
                : 'Run a demo above and each task it creates will appear here with its progress.'
            }
          />
        ) : (
          <ul className="space-y-1.5">
            {visible.map((dialog) => {
              const plain = STATE_PLAIN[dialog.state] ?? STATE_PLAIN.INITIATED;
              const stateStyle = STATE_STYLE[dialog.state] ?? STATE_STYLE.INITIATED;
              const toneName = toneForState(dialog.state);
              const t = TONE_CLASSES[toneName];
              const isSelected = selectedId === dialog.id;

              return (
                <li key={dialog.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(dialog.id)}
                    className={`w-full rounded-2xl border px-3.5 py-3 text-left transition-all duration-200 ${
                      isSelected
                        ? `${t.border} ${t.bg}`
                        : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.045]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${t.dot} ${dialog.settled ? '' : 'animate-breathe'}`} />
                      <span className="truncate font-mono text-[11px] text-slate-500">{dialog.id}</span>
                      <span className={`ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wider ring-1 ${stateStyle.chip}`}>
                        {plain.label}
                      </span>
                    </div>

                    <p className="mt-1.5 text-[12.5px] leading-snug text-slate-300">{describeTask(dialog)}</p>

                    <div className="mt-2.5 flex items-center gap-3">
                      <PacketStrip ledger={dialog.ledger} />
                      <span className="tabular ml-auto shrink-0 text-[11px] text-slate-500">
                        {dialog.sideEffects} of {dialog.ledger.length} work items
                      </span>
                    </div>

                    {dialog.suppressed > 0 ? (
                      <p className="mt-2 text-[11.5px] font-medium text-violet-300">
                        {dialog.suppressed} duplicate{dialog.suppressed > 1 ? 's' : ''} blocked
                      </p>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
