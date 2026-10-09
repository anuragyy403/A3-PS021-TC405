import { Fingerprint, LifeBuoy, RotateCcw, Shuffle, Zap } from 'lucide-react';

/* ------------------------------------------------------------------ *
 * Plain-language vocabulary
 *
 * The backend speaks in dialog_id / task_id / seq and lifecycle states.
 * Everything a human reads is translated through the maps below, so the
 * vocabulary lives in one place and the interface can stay plain.
 * ------------------------------------------------------------------ */

/** The five backend lifecycle states (backend/src/types/index.ts). */
export const LIFECYCLE_STATES = ['INITIATED', 'PROCESSING', 'COMMITTED', 'RECOVERED', 'FAILED'];

export const TERMINAL_STATES = ['COMMITTED', 'RECOVERED', 'FAILED'];

/** The backend's transition table, mirrored for reference (the backend enforces it). */
export const VALID_TRANSITIONS = {
  INITIATED: ['PROCESSING', 'FAILED'],
  PROCESSING: ['COMMITTED', 'RECOVERED', 'FAILED'],
  COMMITTED: [],
  RECOVERED: [],
  FAILED: [],
};

/** What each lifecycle state means, in one sentence. */
export const STATE_PLAIN = {
  INITIATED: { label: 'Not started yet', hint: 'The task has been created; no request has been processed yet.' },
  PROCESSING: { label: 'In progress', hint: 'Requests are being sent and processed.' },
  COMMITTED: { label: 'Completed', hint: 'Completed normally; a repeated request was answered from the stored result, not run again.' },
  RECOVERED: { label: 'Recovered', hint: 'Completed after a backend restart, from the state saved in the SQLite file.' },
  FAILED: { label: 'Failed', hint: 'The task stopped before finishing — the retry limit was reached or it was aborted.' },
};

/** Colour for each lifecycle state, expressed as plain Tailwind tokens. */
export const STATE_STYLE = {
  INITIATED: {
    chip: 'bg-slate-500/15 text-slate-300 ring-slate-400/30',
    solid: 'bg-slate-500/20 text-slate-200 ring-slate-300/40',
    dot: 'bg-slate-400',
    text: 'text-slate-300',
    ring: 'ring-slate-400/30',
  },
  PROCESSING: {
    chip: 'bg-sky-500/15 text-sky-300 ring-sky-400/30',
    solid: 'bg-sky-500/20 text-sky-100 ring-sky-400/50',
    dot: 'bg-sky-400',
    text: 'text-sky-300',
    ring: 'ring-sky-400/30',
  },
  COMMITTED: {
    chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
    solid: 'bg-emerald-500/20 text-emerald-100 ring-emerald-400/50',
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    ring: 'ring-emerald-400/30',
  },
  RECOVERED: {
    chip: 'bg-cyan-500/15 text-cyan-300 ring-cyan-400/30',
    solid: 'bg-cyan-500/20 text-cyan-100 ring-cyan-400/50',
    dot: 'bg-cyan-400',
    text: 'text-cyan-300',
    ring: 'ring-cyan-400/30',
  },
  FAILED: {
    chip: 'bg-rose-500/15 text-rose-300 ring-rose-400/30',
    solid: 'bg-rose-500/20 text-rose-100 ring-rose-400/50',
    dot: 'bg-rose-400',
    text: 'text-rose-300',
    ring: 'ring-rose-400/30',
  },
};

/** Emitters of telemetry inside the mesh, renamed for a general audience. */
export const LAYERS = {
  'adapter-a': { label: 'Sender Agent', tone: 'text-sky-300' },
  'adapter-b': { label: 'Receiver Agent', tone: 'text-violet-300' },
  sqlite: { label: 'Saved State Database', tone: 'text-cyan-300' },
  bridge: { label: 'Network Channel', tone: 'text-amber-300' },
  control: { label: 'System', tone: 'text-slate-300' },
};

export const LAYER_LABEL = Object.fromEntries(Object.entries(LAYERS).map(([key, value]) => [key, value.label]));

/** Log entry classifications exposed as stream filters. */
export const LOG_KINDS = ['success', 'duplicate', 'recovery', 'error'];

/** Health of the supervised components. */
export const NODE_DEFS = [
  { key: 'adapterA', label: 'Sender Agent', sub: 'creates and sends tasks', Icon: 'send', accent: 'sky' },
  { key: 'adapterB', label: 'Receiver Agent', sub: 'processes each (dialog, seq) once', Icon: 'server', accent: 'violet' },
  { key: 'bridge', label: 'Network Channel', sub: 'in-process transport, can lose messages', Icon: 'network', accent: 'amber' },
  { key: 'storage', label: 'Saved State Database', sub: 'SQLite file, saved after every change', Icon: 'database', accent: 'cyan' },
];

export const STATUS_STYLE = {
  online: { dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'ring-emerald-400/30', label: 'Connected' },
  degraded: { dot: 'bg-amber-400', text: 'text-amber-300', ring: 'ring-amber-400/30', label: 'Unstable' },
  booting: { dot: 'bg-sky-400', text: 'text-sky-300', ring: 'ring-sky-400/30', label: 'Restarting' },
  offline: { dot: 'bg-rose-500', text: 'text-rose-300', ring: 'ring-rose-400/30', label: 'Disconnected' },
};

/**
 * The five mandatory PS-021 demonstrations, described from what the backend
 * scripts actually do (backend/src/scenarios/scenario1..5.ts).  `title` is the
 * backend title without its "Scenario N — " prefix.
 *
 * `tone` drives the card, the pipeline highlight and the feed tint, so the
 * colour of a card always matches the colour of what the pipeline does.
 */
export const SCENARIOS = [
  {
    id: 1,
    title: 'Multiple Dialogs + Retry → Correct Correlation',
    tagline: 'Two dialogs open; a lost request is retried',
    description: "Opens two dialogs (D1/T1 and D2/T2). D2's seq 1 is lost before the Receiver sees it. The script then retries the same D2 / T2 / seq 1: it is processed once and answered for D2, while D1 is untouched. D2 is completed; D1 is left open, not started.",
    outcome: 'The retry is correlated to D2 only; D2 ends COMMITTED',
    watch: ['D2 seq 1 lost', 'Explicit retry, same ids', 'D1 untouched'],
    Icon: Zap,
    tone: 'emerald',
  },
  {
    id: 2,
    title: 'Request Lost → Retry',
    tagline: 'The request never arrives, then is retried',
    description: 'Opens one dialog and sends seq 1 with the request lost: nothing is processed and seq 1 stays pending at the Sender. The script retries the same dialog_id / task_id / seq. The Receiver has never seen it, so it processes it once, and the task is completed.',
    outcome: 'The retry is processed once; the task ends COMMITTED',
    watch: ['Request lost', 'Explicit retry, same ids', 'Work done once'],
    Icon: RotateCcw,
    tone: 'amber',
  },
  {
    id: 3,
    title: 'Response Lost → Duplicate Request',
    tagline: 'Work done, reply lost, retry recognised',
    description: 'The Receiver processes seq 1 (the work runs once), then the reply is lost. The script retries the same dialog / task / seq. The Receiver finds its saved record of seq 1, returns the stored result and does not run the work again. The task is completed.',
    outcome: 'Duplicate detected, work not repeated; the task ends COMMITTED',
    watch: ['Reply lost', 'Retry is a duplicate', 'Stored answer returned'],
    Icon: Fingerprint,
    tone: 'violet',
  },
  {
    id: 4,
    title: 'Adapter B Restart → Durable State Recovery',
    tagline: 'The whole backend restarts from its SQLite file',
    description: 'Seq 1 is processed and its reply is lost. "Restart Adapter B" then restarts the whole backend process: both adapters share one SQLite file and are rebuilt from it. The task is reloaded with the same ids, next seq 2 and seq 1 still unanswered. Retrying seq 1 returns the stored result without running the work again; completing the task marks it Recovered.',
    outcome: 'Same task reloaded, no work repeated; the task ends RECOVERED',
    watch: ['Full process restart', 'Reloaded from SQLite', 'Retry is a duplicate'],
    Icon: LifeBuoy,
    tone: 'cyan',
  },
  {
    id: 5,
    title: 'Mid-Task Disconnect + Adapter A Restart → Resume',
    tagline: 'Restart mid-task, then continue the same task',
    description: 'Seq 1 and 2 are processed; seq 3 is processed but its reply is lost. "Restart Adapter A" restarts the whole backend process from the SQLite file. The same dialog and task are reloaded with seq 3 unanswered and next seq 4, derived from the saved state. Retries of seq 3 and seq 1 are duplicates, the next request gets seq 4, and the task is marked Recovered.',
    outcome: 'Same dialog_id / task_id resumed at seq 4; the task ends RECOVERED',
    watch: ['Full process restart', 'Next seq from saved state', 'Same dialog_id / task_id'],
    Icon: Shuffle,
    tone: 'sky',
  },
];

/** Colour themes keyed by the tones used in SCENARIOS. */
export const SCENARIO_TONE = {
  emerald: {
    text: 'text-emerald-300',
    ring: 'ring-emerald-400/30',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-400/40',
    glow: 'shadow-[0_0_40px_-16px_rgba(16,185,129,0.85)]',
    dot: 'bg-emerald-400',
    grad: 'from-emerald-400 to-teal-400',
  },
  amber: {
    text: 'text-amber-300',
    ring: 'ring-amber-400/30',
    bg: 'bg-amber-500/10',
    border: 'border-amber-400/40',
    glow: 'shadow-[0_0_40px_-16px_rgba(251,191,36,0.85)]',
    dot: 'bg-amber-400',
    grad: 'from-amber-400 to-yellow-400',
  },
  sky: {
    text: 'text-sky-300',
    ring: 'ring-sky-400/30',
    bg: 'bg-sky-500/10',
    border: 'border-sky-400/40',
    glow: 'shadow-[0_0_40px_-16px_rgba(56,189,248,0.85)]',
    dot: 'bg-sky-400',
    grad: 'from-sky-400 to-blue-400',
  },
  violet: {
    text: 'text-violet-300',
    ring: 'ring-violet-400/30',
    bg: 'bg-violet-500/10',
    border: 'border-violet-400/40',
    glow: 'shadow-[0_0_40px_-16px_rgba(167,139,250,0.85)]',
    dot: 'bg-violet-400',
    grad: 'from-violet-400 to-purple-400',
  },
  orange: {
    text: 'text-orange-300',
    ring: 'ring-orange-400/30',
    bg: 'bg-orange-500/10',
    border: 'border-orange-400/40',
    glow: 'shadow-[0_0_40px_-16px_rgba(251,146,60,0.85)]',
    dot: 'bg-orange-400',
    grad: 'from-orange-400 to-amber-400',
  },
  cyan: {
    text: 'text-cyan-300',
    ring: 'ring-cyan-400/30',
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-400/40',
    glow: 'shadow-[0_0_40px_-16px_rgba(34,211,238,0.85)]',
    dot: 'bg-cyan-400',
    grad: 'from-cyan-400 to-teal-400',
  },
};

/** The four headline numbers on the executive summary bar. */
export const HEADLINE_METRICS = [
  { key: 'connection', label: 'Connection Status', Icon: 'wifi', tone: 'emerald' },
  { key: 'tasks', label: 'Total Tasks Processed', Icon: 'tasks', tone: 'sky' },
  { key: 'duplicates', label: 'Duplicates Blocked', Icon: 'copy', tone: 'violet' },
  { key: 'recovery', label: 'Recovery Success Rate', Icon: 'recovery', tone: 'cyan' },
];
