import { HEADLINE_METRICS, NODE_DEFS, STATUS_STYLE } from '../lib/constants.js';
import { IconTile } from './ui/Glass.jsx';
import { tone } from './ui/tokens.js';

/** Formats a millisecond uptime as a compact "4m 12s" style string. */
function uptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * A single headline figure.
 *
 * Every card answers one question a non-technical viewer might ask, in this
 * order: what is it called, what is the number, and what does that number mean.
 */
function MetricCard({ icon, label, tone: toneName, value, sub, footnote, pulse }) {
  const t = tone(toneName);
  return (
    <article className={`glass glass-hover flex flex-col gap-3 p-5 ${t.glow}`}>
      <span className="glass-sheen" aria-hidden="true" />
      <div className="flex items-start gap-3">
        <IconTile name={icon} tone={toneName} pulse={pulse} />
        <div className="min-w-0 flex-1">
          <p className="overline leading-tight">{label}</p>
          <p className="mt-1.5 truncate text-[26px] font-extrabold leading-none tracking-tight text-white">{value}</p>
        </div>
      </div>
      <p className="text-[12.5px] leading-snug text-slate-400">{sub}</p>
      {footnote ? <div className="mt-auto pt-1">{footnote}</div> : null}
    </article>
  );
}

/**
 * The executive summary: four numbers that tell the whole story of the system
 * without opening a single log line.
 */
export default function MetricBar({ metrics, nodes }) {
  const sender = nodes.adapterA?.status ?? 'online';
  const channel = nodes.bridge?.status ?? 'online';
  const receiver = nodes.adapterB?.status ?? 'online';
  const storage = nodes.storage?.status ?? 'online';

  const statuses = { sender, channel, receiver, storage };
  const onlineCount = [sender, channel, receiver, storage].filter((value) => value === 'online').length;

  let connectionTone = 'good';
  let connectionValue = 'Connected';
  let connectionSub = 'Sender, network, receiver and database are all online';
  if ([sender, channel, receiver].includes('offline')) {
    connectionTone = 'bad';
    connectionValue = 'Disconnected';
    connectionSub = 'The Sender Agent cannot reach the Receiver Agent';
  } else if (sender === 'booting') {
    connectionTone = 'info';
    connectionValue = 'Restarting';
    connectionSub = 'The Sender Agent is reloading its unfinished tasks';
  } else if (channel === 'degraded') {
    connectionTone = 'warn';
    connectionValue = 'Unstable';
    connectionSub = 'The network channel is dropping packets right now';
  }

  const inProgress = metrics.activeDialogs ?? 0;
  const finished = (metrics.committed ?? 0) + (metrics.recovered ?? 0);
  const totalTasks = metrics.totalDialogs ?? 0;

  const duplicates = metrics.dedup ?? 0;
  const rate = metrics.recoveryRate;

  // Backend-only detail (undefined in the browser simulation, whose wording is kept).
  const hasSplit = typeof metrics.inProgress === 'number' && typeof metrics.notStarted === 'number';
  const failedTasks = metrics.failed ?? 0;
  const restoredOpen = metrics.restoredOpen ?? 0;

  let tasksSub;
  if (totalTasks === 0) {
    tasksSub = 'No tasks yet — run one of the demos below';
  } else if (!hasSplit) {
    tasksSub = inProgress > 0
      ? `${inProgress} still running, ${finished} finished successfully`
      : `All ${finished} finished successfully, nothing repeated`;
  } else if (metrics.inProgress + metrics.notStarted === 0 && failedTasks === 0) {
    tasksSub = `All ${finished} finished successfully, nothing repeated`;
  } else {
    tasksSub = [
      metrics.inProgress ? `${metrics.inProgress} in progress` : null,
      metrics.notStarted ? `${metrics.notStarted} not started` : null,
      `${finished} finished successfully`,
      failedTasks ? `${failedTasks} stopped early` : null,
    ].filter(Boolean).join(', ');
  }

  const openNote = restoredOpen ? `${restoredOpen} restored task${restoredOpen === 1 ? '' : 's'} still open` : null;
  let rateValue = rate === null || rate === undefined ? '100%' : `${Math.round(rate)}%`;
  let rateSub = rate === null || rate === undefined
    ? 'Nothing has needed rescuing yet'
    : `${metrics.recoverySucceeded} of ${metrics.recoveryAttempted} recoveries succeeded`;
  if (openNote) {
    if (rate === null || rate === undefined) {
      rateValue = '—';
      rateSub = `${openNote} — not finished yet, so not counted`;
    } else {
      rateSub = `${rateSub} · ${openNote}`;
    }
  }

  const cards = [
    {
      ...HEADLINE_METRICS[0],
      tone: connectionTone,
      value: connectionValue,
      sub: connectionSub,
      pulse: sender === 'online',
      footnote: (
        <div className="flex items-center gap-1.5">
          {NODE_DEFS.map((node) => {
            const status = statuses[node.key];
            const style = STATUS_STYLE[status] ?? STATUS_STYLE.online;
            return (
              <span
                key={node.key}
                title={`${node.label}: ${style.label}`}
                className="flex items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-1 text-[10px] font-medium text-slate-400"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                <span className="hidden xl:inline">{node.label}</span>
                <span className="xl:hidden">{node.label.split(' ')[0]}</span>
              </span>
            );
          })}
        </div>
      ),
    },
    {
      ...HEADLINE_METRICS[1],
      tone: 'info',
      value: String(totalTasks),
      sub: tasksSub,
      footnote: (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-sky-400 to-cyan-300 transition-[width] duration-700"
            style={{ width: `${totalTasks ? Math.round((finished / totalTasks) * 100) : 0}%` }}
          />
        </div>
      ),
    },
    {
      ...HEADLINE_METRICS[2],
      tone: 'duplicate',
      value: String(duplicates),
      sub:
        duplicates === 0
          ? 'No repeated work has been requested'
          : `${duplicates} repeat cop${duplicates === 1 ? 'y was' : 'ies were'} spotted and skipped`,
      footnote: (
        <p className="text-[11px] leading-snug text-slate-500">
          A repeat copy is recognised by its task and packet number, so the work is never done twice.
        </p>
      ),
    },
    {
      ...HEADLINE_METRICS[3],
      tone: 'good',
      value: rateValue,
      sub: rateSub,
      footnote: (
        <p className="text-[11px] leading-snug text-slate-500">
          When a packet is lost or an agent crashes, the work is picked back up from the database and finished.
        </p>
      ),
    },
  ];

  return (
    <section aria-label="Executive summary">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.18em] text-slate-400">At a glance</h2>
        <p className="text-[12.5px] text-slate-600">
          {onlineCount} of 4 components online &middot; running for {uptime(metrics.uptimeMs ?? 0)}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <MetricCard
            key={card.key}
            icon={card.Icon}
            label={card.label}
            tone={card.tone}
            value={card.value}
            sub={card.sub}
            footnote={card.footnote}
            pulse={card.pulse}
          />
        ))}
      </div>
    </section>
  );
}
