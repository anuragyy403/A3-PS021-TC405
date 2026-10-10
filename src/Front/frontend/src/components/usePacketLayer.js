import { useEffect, useRef } from 'react';
import { TONE_CLASSES } from './ui/tokens.js';

/**
 * Turning the backend's wire feed (mappers.mapEventToWire) into animation.
 *
 * The animations are deliberately imperative rather than React state: a busy
 * demo can emit a dozen packets a second, and re-rendering the whole panel for
 * each one would be wasteful. Instead each event becomes a throwaway DOM element
 * that removes itself when its animation ends, and nothing in React has to keep
 * track of what is currently in flight.
 */

/** Class strings are written out in full so Tailwind can see them. */
const FLY_FORWARD = 'pointer-events-none absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 opacity-0 animate-packet-fly';
const FLY_BACKWARD = 'pointer-events-none absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 opacity-0 animate-packet-fly-back';
const FLY_BODY = 'grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold backdrop-blur-sm';
const MARK_HOST = 'pointer-events-none absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 opacity-0';
const MARK_BODY =
  'animate-marker-pop absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-2xl text-[15px] font-bold ring-1 backdrop-blur-sm';
const DB_HOST = 'pointer-events-none absolute inset-0 z-20 grid place-items-center opacity-0';
const DB_BODY = 'animate-marker-pop absolute grid h-10 w-10 place-items-center rounded-2xl text-[17px] font-bold ring-1 backdrop-blur-sm';

/**
 * How each wire phase is drawn (exactly the phases mappers.js produces).
 *
 * `fly` travels the whole channel, `mark` appears in place at `at`% of the
 * channel, and `db` appears over the saved-state database. Glyphs are plain
 * characters rather than icons so that a dozen can animate at once without
 * mounting a dozen SVG trees.
 */
const PHASE_VISUALS = {
  sent: { kind: 'fly', toneName: 'info' },
  resent: { kind: 'fly', toneName: 'warn', glyph: '↻' },
  delivered: { kind: 'mark', toneName: 'good', glyph: '✓', at: 100 },
  done: { kind: 'mark', toneName: 'good', glyph: '✓', at: 100 },
  duplicate: { kind: 'mark', toneName: 'duplicate', glyph: '⊘', at: 100 },
  dropped: { kind: 'mark', toneName: 'bad', glyph: '✕', at: 56 },
  failed: { kind: 'mark', toneName: 'bad', glyph: '✕', at: 100 },
  restored: { kind: 'db', toneName: 'info', glyph: '↺' },
};

/** Safety net in case an animation never fires, e.g. a headless renderer. */
const MAX_LIFETIME = 2600;
const MAX_PER_LAYER = 28;
const STAGGER = 140;
const MAX_STAGGER = 1100;

/** Builds one self-removing animation element and appends it to its layer. */
function spawn(layer, spec, glyph, delay) {
  const t = TONE_CLASSES[spec.toneName] ?? TONE_CLASSES.info;

  const host = document.createElement('span');
  host.setAttribute('aria-hidden', 'true');
  host.style.animationDelay = `${delay}ms`;

  const body = document.createElement('span');
  body.textContent = glyph;
  body.className = `${t.bg} ${t.text} ${t.ring} ${t.glow}`;

  if (spec.kind === 'db') {
    host.className = DB_HOST;
    body.className = `${DB_BODY} ${body.className}`;
    host.appendChild(body);
  } else if (spec.kind === 'fly') {
    host.className = spec.back ? FLY_BACKWARD : FLY_FORWARD;
    if (spec.back) host.style.left = '100%';
    body.className = `${FLY_BODY} ${body.className}`;
    host.appendChild(body);
  } else {
    host.className = MARK_HOST;
    host.style.left = `${spec.at}%`;
    body.className = `${MARK_BODY} ${body.className}`;
    host.appendChild(body);
  }

  // The animation is the primary teardown signal; the timer only covers the
  // case where it never runs.
  let timer = 0;
  const remove = () => {
    clearTimeout(timer);
    host.remove();
  };
  host.addEventListener('animationend', remove, { once: true });
  timer = setTimeout(remove, delay + MAX_LIFETIME);

  layer.appendChild(host);

  while (layer.childElementCount > MAX_PER_LAYER) layer.firstElementChild?.remove();
}

/**
 * Watches the wire feed and animates new events into two layers: the network
 * channel, and the saved-state database.
 */
export function usePacketLayer(wire, reducedMotion) {
  const channelRef = useRef(null);
  const storageRef = useRef(null);

  useEffect(() => {
    if (!Array.isArray(wire) || wire.length === 0) return;
    const channel = channelRef.current;
    const storage = storageRef.current;
    if (!channel || !storage) return;

    // Each layer remembers the last event it drew. A reset restarts the ids at
    // one, which is detected here so animations resume after "Start over".
    const newest = wire[wire.length - 1].id;
    let seen = Number(channel.dataset.lastEvent ?? 0);
    if (newest <= seen) return;
    if (seen > 0 && newest < seen) {
      seen = 0;
      channel.dataset.lastEvent = '0';
      storage.dataset.lastEvent = '0';
    }
    channel.dataset.lastEvent = String(newest);
    storage.dataset.lastEvent = String(newest);

    // Always advance past events, even when not animating, so that turning
    // reduced motion off does not replay the whole backlog at once.
    if (reducedMotion) return;

    wire
      .filter((event) => event.id > seen)
      .forEach((event, index) => {
        const spec = PHASE_VISUALS[event.phase];
        if (!spec) return;
        const layer = spec.kind === 'db' ? storage : channel;
        const delay = Math.min(index * STAGGER, MAX_STAGGER);
        const glyph = event.seq != null && (event.phase === 'sent' || event.phase === 'resent') ? String(event.seq) : spec.glyph;
        spawn(layer, spec, glyph ?? '•', delay);
      });
  }, [wire, reducedMotion]);

  return { channelRef, storageRef };
}
