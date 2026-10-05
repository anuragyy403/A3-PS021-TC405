import { Radio, RotateCcw, Sparkles } from 'lucide-react';
import { Pill } from './ui/Glass.jsx';
import { tone } from './ui/tokens.js';

/**
 * What each connection state looks like and what it is called.
 *
 * Kept as one table so the wording, the colour and the pulse behaviour can never
 * drift apart between the header and the pipeline.
 */
const STATUS = {
  online: { toneName: 'good', label: 'All connected', pulse: false },
  booting: { toneName: 'info', label: 'Restarting the agents', pulse: true },
  degraded: { toneName: 'warn', label: 'Network unstable', pulse: true },
  offline: { toneName: 'bad', label: 'Disconnected', pulse: true },
};

/**
 * Top bar: what this is, which experiment it belongs to, and the one action a
 * demonstrator ever needs. The connection pill lives here so the eye has a single
 * place to check the health of the whole system.
 */
export default function Header({ status, running, onReset }) {
  const look = STATUS[status] ?? STATUS.offline;
  const t = tone(look.toneName);

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-night-950/70 backdrop-blur-2xl">
      <span className="glass-sheen" aria-hidden="true" />
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 lg:px-8">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-sky-400/25 to-violet-500/20 ring-1 ring-inset ring-white/15">
            <Radio size={19} className="text-sky-300" />
            <span className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ${t.dot} ring-2 ring-night-950`} />
          </span>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[17px] font-extrabold tracking-tight text-white">
              Nighthawks
              <span className="hidden rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 ring-1 ring-inset ring-white/10 sm:inline">
                PS-021
              </span>
            </h1>
            <p className="truncate text-[12.5px] text-slate-500">Two AI agents, one unreliable network, zero lost or repeated work</p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          {running ? (
            <Pill tone="info" icon="loader" pulse>
              Demo running
            </Pill>
          ) : null}

          <Pill tone={look.toneName} pulse={look.pulse} className={t.glow}>
            {look.label}
          </Pill>

          <span className="hidden items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[11.5px] font-medium text-slate-500 lg:inline-flex">
            <Sparkles size={12} />
            AIORI-3 &middot; 6G &amp; Future Networks
          </span>

          <button type="button" className="btn-subtle" onClick={onReset} title="Clear all tasks, activity and results, then start fresh">
            <RotateCcw size={14} />
            Start over
          </button>
        </div>
      </div>
    </header>
  );
}
