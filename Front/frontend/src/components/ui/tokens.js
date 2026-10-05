import {
  Activity,
  Antenna,
  Check,
  Copy,
  Database,
  HardDriveDownload,
  Inbox,
  ListChecks,
  Loader,
  Network,
  OctagonX,
  RotateCcw,
  Search,
  Send,
  Server,
  ShieldCheck,
  Shuffle,
  Signal,
  Sparkles,
  TimerReset,
  TriangleAlert,
  Wifi,
  Zap,
} from 'lucide-react';

/**
 * Colour tokens for the semantic tones used across the interface.
 *
 * Every value is a complete Tailwind class written out in full, because these
 * strings get concatenated into class names at runtime and Tailwind can only see
 * what appears literally in the source.
 */
export const TONE_CLASSES = {
  good: {
    text: 'text-emerald-300',
    ring: 'ring-emerald-400/30',
    bg: 'bg-emerald-500/[0.14]',
    border: 'border-emerald-400/30',
    dot: 'bg-emerald-400',
    glow: 'shadow-[0_0_30px_-14px_rgba(16,185,129,0.95)]',
  },
  warn: {
    text: 'text-amber-300',
    ring: 'ring-amber-400/30',
    bg: 'bg-amber-500/[0.14]',
    border: 'border-amber-400/30',
    dot: 'bg-amber-400',
    glow: 'shadow-[0_0_30px_-14px_rgba(251,191,36,0.95)]',
  },
  bad: {
    text: 'text-rose-300',
    ring: 'ring-rose-400/30',
    bg: 'bg-rose-500/[0.14]',
    border: 'border-rose-400/30',
    dot: 'bg-rose-400',
    glow: 'shadow-[0_0_30px_-14px_rgba(244,63,94,0.95)]',
  },
  info: {
    text: 'text-sky-300',
    ring: 'ring-sky-400/30',
    bg: 'bg-sky-500/[0.14]',
    border: 'border-sky-400/30',
    dot: 'bg-sky-400',
    glow: 'shadow-[0_0_30px_-14px_rgba(56,189,248,0.95)]',
  },
  duplicate: {
    text: 'text-violet-300',
    ring: 'ring-violet-400/30',
    bg: 'bg-violet-500/[0.14]',
    border: 'border-violet-400/30',
    dot: 'bg-violet-400',
    glow: 'shadow-[0_0_30px_-14px_rgba(167,139,250,0.95)]',
  },
  idle: {
    text: 'text-slate-400',
    ring: 'ring-white/10',
    bg: 'bg-white/[0.05]',
    border: 'border-white/10',
    dot: 'bg-slate-500',
    glow: '',
  },
};

export const tone = (name) => TONE_CLASSES[name] ?? TONE_CLASSES.idle;

/**
 * Icon registry, keyed by string so that neither the components nor the
 * narration layer have to import lucide directly. Swapping the icon set is a
 * change to this one object.
 */
export const ICONS = {
  /* pipeline nodes */
  send: Send,
  server: Server,
  network: Network,
  database: Database,

  /* metric bar */
  wifi: Wifi,
  tasks: ListChecks,
  copy: Copy,
  recovery: ShieldCheck,

  /* narration */
  x: OctagonX,
  crash: Zap,
  recover: HardDriveDownload,
  rotate: RotateCcw,
  alert: TriangleAlert,
  resend: TimerReset,
  shield: ShieldCheck,
  hold: Inbox,
  shuffle: Shuffle,
  check: Check,
  save: HardDriveDownload,
  task: ListChecks,
  info: Activity,

  /* chrome */
  sparkles: Sparkles,
  signal: Signal,
  antenna: Antenna,
  loader: Loader,
  search: Search,
};

/** Resolves an icon key, falling back to a neutral glyph. */
export const iconFor = (key) => ICONS[key] ?? Activity;
