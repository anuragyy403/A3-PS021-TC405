import { useMemo } from 'react';
import { IconTile, Pill } from './ui/Glass.jsx';
import { TONE_CLASSES } from './ui/tokens.js';
import { usePrefersReducedMotion } from './ui/hooks.js';
import { usePacketLayer } from './usePacketLayer.js';
import { narrate } from '../lib/narrate.js';

/** One of the boxes in the diagram. */
function NodeCard({ icon, name, role, toneName, statusLabel, pulse, stats, className = '' }) {
  const t = TONE_CLASSES[toneName] ?? TONE_CLASSES.info;
  return (
    <div className={`glass w-[168px] shrink-0 p-4 sm:w-[196px] ${className}`}>
      <span className="glass-sheen" aria-hidden="true" />
      <div className="flex items-center gap-2.5">
        <IconTile name={icon} tone={toneName} size="md" pulse={pulse} />
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-bold leading-tight text-white">{name}</p>
          <p className="truncate text-[10.5px] uppercase tracking-[0.12em] text-slate-500">{role}</p>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-slate-400">{stats.blurb}</p>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
          <span className={`h-1.5 w-1.5 rounded-full ${t.dot} ${pulse ? 'animate-breathe' : ''}`} />
          {statusLabel}
        </span>
        <span className="tabular text-[11px] font-semibold text-slate-300">{stats.value}</span>
      </div>
    </div>
  );
}

/**
 * The live pipeline.
 *
 * This is the piece a demonstrator can point at: the three boxes are the two
 * agents and the link between them, the moving dots are packets in flight, and
 * the markers are the faults happening right now. Everything it draws is driven
 * by the backend's event feed, so the animation cannot drift from the real state.
 * `manualPanel` (ManualControls) is rendered underneath.
 */
export default function PipelineVisualizer({ wire, logs, nodes, metrics, highlightedTone, manualPanel = null }) {
  const reducedMotion = usePrefersReducedMotion();
  const { channelRef, storageRef } = usePacketLayer(wire, reducedMotion);


  const theme = TONE_CLASSES[highlightedTone] ?? TONE_CLASSES.info;

  const senderStatus = nodes.adapterA?.status ?? 'online';
  const channelStatus = nodes.bridge?.status ?? 'online';
  const receiverStatus = nodes.adapterB?.status ?? 'online';
  const storageStatus = nodes.storage?.status ?? 'online';

  /* --- the one-line explanation of what is happening right now --------- */
  const headline = useMemo(() => {
    for (let index = logs.length - 1; index >= 0 && index >= logs.length - 60; index -= 1) {
      const entry = logs[index];
      const spoken = narrate(entry);
      if (spoken.headline && spoken.headline !== String(entry.msg)) return spoken;
      if (['dialog opened', 'dispatch seq'].some((needle) => String(entry.msg).includes(needle))) return spoken;
    }
    return null;
  }, [logs]);

  const channelNote =
    channelStatus === 'offline'
      ? 'The channel is down — nothing can get through'
      : channelStatus === 'degraded'
        ? 'The channel is dropping packets right now'
        : channelStatus === 'booting'
          ? 'The channel is coming back up'
          : 'Requests or replies can be lost — the sender retries with the same ids';

  return (
    <section className="glass overflow-hidden">
      <span className="glass-sheen" aria-hidden="true" />

      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pb-1 pt-5">
        <IconTile name="network" tone={highlightedTone ?? 'info'} size="md" pulse={Boolean(highlightedTone)} />
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-white">Live message pipeline</h2>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            Watch packets travel between the two agents and react to everything the network does to them.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {reducedMotion ? (
            <Pill tone="idle">Animations off (reduced motion)</Pill>
          ) : null}
          <Pill tone="idle" icon="signal">
            {metrics.packets ?? 0} packets sent
          </Pill>
        </div>
      </header>

      {/* ---------------- the diagram ---------------- */}
      <div className="bg-dots relative mx-6 mt-4 rounded-2xl border border-white/[0.06] bg-night-950/40 px-4 py-6 sm:px-6">
        {highlightedTone ? (
          <span className={`pointer-events-none absolute inset-0 rounded-2xl ring-1 ${theme.ring}`} aria-hidden="true" />
        ) : null}

        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0 sm:gap-x-8">
          <NodeCard
            icon="send"
            name="Sender Agent"
            role="creates the task"
            toneName="info"
            statusLabel={senderStatus === 'online' ? 'Online' : senderStatus === 'booting' ? 'Restarting' : 'Offline'}
            pulse={senderStatus === 'online'}
            stats={{ blurb: 'Numbers every packet, then sends them across the network.', value: `${metrics.packets ?? 0} sent` }}
          />

          {/* -------- channel -------- */}
          <div className="flex min-w-0 flex-col gap-2 px-1">
            <div className="flex items-center justify-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full bg-amber-400 ${channelStatus === 'degraded' ? 'animate-ring-out-amber' : 'animate-breathe'}`} />
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-slate-500">Network Channel</span>
            </div>

            <div className="relative h-14">
              <div className="channel-track absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 opacity-70" />
              <div
                className={`channel-live absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 ${
                  channelStatus === 'online' ? 'opacity-80' : 'opacity-20'
                }`}
              />
              {channelStatus !== 'online' ? (
                <div
                  className={`absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 ${
                    channelStatus === 'degraded' || channelStatus === 'offline' ? 'bg-rose-500/50' : 'bg-sky-500/40'
                  }`}
                />
              ) : null}

              {/* Packets and fault markers are spawned here as they happen. */}
              <span ref={channelRef} className="absolute inset-0" aria-hidden="true" />
            </div>

            <p className="truncate text-center text-[11.5px] text-slate-500">{channelNote}</p>
          </div>

          <NodeCard
            icon="server"
            name="Receiver Agent"
            role="does the work"
            toneName="duplicate"
            statusLabel={receiverStatus === 'online' ? 'Online' : 'Waiting'}
            pulse={receiverStatus === 'online'}
            stats={{ blurb: 'Processes each new (dialog, seq) once; a repeat gets the stored answer.', value: `${metrics.sideEffects ?? 0} done` }}
          />

          {/* -------- saved state database, hung off the receiver -------- */}
          <div className="col-start-3 row-start-2 mx-auto flex h-7 w-px flex-col items-center">
            <span className={`h-full w-px ${storageStatus === 'online' ? 'border-l border-dashed border-cyan-400/40' : 'border-l border-dashed border-rose-400/40'}`} />
          </div>

          <div className="glass relative col-start-3 row-start-3 w-[168px] p-4 sm:w-[196px]">
            <span className="glass-sheen" aria-hidden="true" />
            <div className="flex items-center gap-2.5">
              <IconTile name="database" tone="info" size="md" pulse={storageStatus === 'online'} />
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-bold leading-tight text-white">Saved State</p>
                <p className="truncate text-[10.5px] uppercase tracking-[0.12em] text-slate-500">SQLite file</p>
              </div>
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-slate-400">
              Saved after every change; a restart reloads unfinished tasks from this file.
            </p>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
                <span className={`h-1.5 w-1.5 rounded-full bg-cyan-400 ${storageStatus === 'online' ? 'animate-breathe' : ''}`} />
                {storageStatus === 'online' ? 'Saving' : 'Offline'}
              </span>
              <span className="tabular text-[11px] font-semibold text-slate-300">{metrics.durableDialogs ?? 0} saved</span>
            </div>

            {/* Restore markers appear over the database when state is reloaded. */}
            <span ref={storageRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
          </div>
        </div>
      </div>

      {/* ---------------- plain-language status line ---------------- */}
      <div className="px-6 pt-4">
        <div
          className={`flex items-start gap-3 rounded-2xl border px-4 py-3.5 transition-colors duration-300 ${
            headline ? `${TONE_CLASSES[headline.tone].bg} ${TONE_CLASSES[headline.tone].border}` : 'border-white/[0.07] bg-white/[0.02]'
          }`}
        >
          <IconTile name={headline?.Icon ?? 'sparkles'} tone={headline?.tone ?? 'idle'} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="overline">Happening right now</p>
            <p className={`mt-1 text-[14px] font-semibold leading-snug ${headline ? 'text-white' : 'text-slate-300'}`}>
              {headline?.headline ?? 'Everything is connected and idle. Run a demo below to see it handle trouble.'}
            </p>
            {headline?.detail ? <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">{headline.detail}</p> : null}
          </div>
          {headline?.source ? (
            <span className="hidden shrink-0 self-center text-[11px] font-medium text-slate-500 sm:block">{headline.source}</span>
          ) : null}
        </div>
      </div>

      {manualPanel}
    </section>
  );
}
