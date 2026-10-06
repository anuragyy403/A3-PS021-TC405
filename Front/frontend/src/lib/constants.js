import {
  Copy,
  Fingerprint,
  HeartPulse,
  LifeBuoy,
  Radar,
  RotateCcw,
  Shuffle,
  Zap,
} from 'lucide-react';

/* ------------------------------------------------------------------ *
 * Plain-language vocabulary
 *
 * The engine speaks in protocol terms (seq, NACK, WAL, rehydration) because
 * that is what the audit trail has to record. Everything a human reads is
 * translated through the maps below, so the jargon exists in exactly one place
 * and the interface can stay plain.
 * ------------------------------------------------------------------ */

/** Lifecycle states, with the label a non-technical audience actually needs. */
export const LIFECYCLE_STATES = [
  'INITIATED',
  'PROCESSING',
  'WAITING_ACK',
  'COMMITTED',
  'RECOVERED',
  'FAILED',
];

/** Non-terminal phases rendered as the linear spine of the stepper. */
export const PHASE_STATES = ['INITIATED', 'PROCESSING', 'WAITING_ACK'];

/** Terminal states rendered as the branch of the stepper. */
export const TERMINAL_STATES = ['COMMITTED', 'RECOVERED', 'FAILED'];

export const TERMINAL_SET = new Set(TERMINAL_STATES);

export const isTerminal = (state) => TERMINAL_SET.has(state);

/**
 * Authoritative transition table. Any attempt to move a dialog along an edge
 * that is not listed here is rejected by the engine and logged as an error,
 * which is what keeps the correlation invariants auditable.
 */
export const VALID_TRANSITIONS = {
  INITIATED: ['PROCESSING', 'FAILED'],
  PROCESSING: ['WAITING_ACK', 'FAILED'],
  WAITING_ACK: ['PROCESSING', 'COMMITTED', 'RECOVERED', 'FAILED'],
  COMMITTED: [],
  RECOVERED: [],
  FAILED: [],
};

export const canTransition = (from, to) => (VALID_TRANSITIONS[from] ?? []).includes(to);

/** What each lifecycle state means, in one sentence. */
export const STATE_PLAIN = {
  INITIATED: { label: 'Not started yet', hint: 'The task has been created but no packet has arrived.' },
  PROCESSING: { label: 'In progress', hint: 'Packets are arriving and work is being done.' },
  WAITING_ACK: { label: 'Waiting for confirmation', hint: 'All work is done, waiting for the receiver to confirm.' },
  COMMITTED: { label: 'Completed', hint: 'Every packet was processed exactly once.' },
  RECOVERED: { label: 'Recovered', hint: 'The sender crashed, then finished the task from saved state.' },
  FAILED: { label: 'Failed', hint: 'A packet never arrived, so the task could not be completed.' },
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
  WAITING_ACK: {
    chip: 'bg-amber-500/15 text-amber-300 ring-amber-400/30',
    solid: 'bg-amber-500/20 text-amber-100 ring-amber-400/50',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    ring: 'ring-amber-400/30',
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

/** The four moving parts of the system, as the pipeline presents them. */
export const PIPELINE_NODES = [
  {
    key: 'sender',
    label: 'Sender Agent',
    plain: 'Creates the task and sends numbered packets.',
    Icon: 'send',
    accent: 'sky',
  },
  {
    key: 'channel',
    label: 'Network Channel',
    plain: 'The unreliable 6G link. Packets can be lost, delayed or shuffled.',
    Icon: 'network',
    accent: 'amber',
  },
  {
    key: 'receiver',
    label: 'Receiver Agent',
    plain: 'Applies each packet exactly once, in the right order.',
    Icon: 'server',
    accent: 'violet',
  },
  {
    key: 'database',
    label: 'Saved State Database',
    plain: 'Keeps a checkpoint after every step, so a crash is recoverable.',
    Icon: 'database',
    accent: 'cyan',
  },
];

/** Log entry classifications exposed as stream filters. */
export const LOG_KINDS = ['success', 'duplicate', 'recovery', 'error'];

export const LOG_KIND_STYLE = {
  success: { label: 'Success', text: 'text-emerald-300' },
  duplicate: { label: 'Blocked', text: 'text-violet-300' },
  recovery: { label: 'Recovery', text: 'text-amber-300' },
  error: { label: 'Problem', text: 'text-rose-300' },
};

/** Health of the supervised components. */
export const NODE_DEFS = [
  { key: 'adapterA', label: 'Sender Agent', sub: 'creates and sends tasks', Icon: 'send', accent: 'sky' },
  { key: 'adapterB', label: 'Receiver Agent', sub: 'applies each packet once', Icon: 'server', accent: 'violet' },
  { key: 'bridge', label: 'Network Channel', sub: '6G slice transport', Icon: 'network', accent: 'amber' },
  { key: 'storage', label: 'Saved State Database', sub: 'crash-safe checkpoints', Icon: 'database', accent: 'cyan' },
];

export const STATUS_STYLE = {
  online: { dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'ring-emerald-400/30', label: 'Connected' },
  degraded: { dot: 'bg-amber-400', text: 'text-amber-300', ring: 'ring-amber-400/30', label: 'Unstable' },
  booting: { dot: 'bg-sky-400', text: 'text-sky-300', ring: 'ring-sky-400/30', label: 'Restarting' },
  offline: { dot: 'bg-rose-500', text: 'text-rose-300', ring: 'ring-rose-400/30', label: 'Disconnected' },
};

/** Wire protocols that the dispatcher can wrap a payload into. */
export const PROTOCOLS = [
  {
    id: 'MCP',
    label: 'MCP',
    plain: 'Standard tool-call format',
    spec: 'JSON-RPC 2.0 · tools/call',
    short: 'MCP',
  },
  {
    id: 'A2A',
    label: 'A2A',
    plain: 'Agent hand-off format',
    spec: 'task + message envelope',
    short: 'A2A',
  },
];

export const PROTOCOL_MAP = Object.fromEntries(PROTOCOLS.map((p) => [p.id, p]));

/**
 * The five mandatory PS-021 demonstrations.
 *
 * `tone` drives the card, the pipeline highlight and the feed tint, so the
 * colour of a card always matches the colour of what the pipeline does.
 */
export const SCENARIOS = [
  {
    id: 1,
    title: 'Multiple Dialogs → Correct Correlation',
    tagline: 'Two tasks running simultaneously',
    description: 'Two independent dialogs (D1, D2) are active at the same time with interleaved requests. A request from D2 is lost and retried. The system correctly correlates each request to its own dialog without cross-contamination.',
    outcome: 'Both dialogs complete independently',
    watch: ['2 dialogs interleaved', 'Lost request retried', 'No cross-contamination'],
    Icon: Zap,
    tone: 'emerald',
    protocol: 'MCP',
  },
  {
    id: 2,
    title: 'Request Lost → Retry',
    tagline: 'Request never arrives, then sent again',
    description: 'A request is sent but lost in the network—it never reaches the receiver. The sender retries after timeout. The receiver processes the retry normally since it has no record of the first attempt.',
    outcome: 'Retry processed successfully',
    watch: ['Request lost in transit', 'Timeout triggers retry', 'Processed normally'],
    Icon: RotateCcw,
    tone: 'amber',
    protocol: 'MCP',
  },
  {
    id: 3,
    title: 'Response Lost → Duplicate Request',
    tagline: 'Work done, response lost, retry detected',
    description: 'The receiver processes a request and performs the side effect, but the response is lost. The sender retries the same request. The receiver detects it as a duplicate using the deduplication record and does not repeat the work.',
    outcome: 'Duplicate detected, work not repeated',
    watch: ['Response lost', 'Request retried', 'Duplicate blocked'],
    Icon: Fingerprint,
    tone: 'violet',
    protocol: 'A2A',
  },
  {
    id: 4,
    title: 'Adapter B Restart → Durable State Recovery',
    tagline: 'Receiver crashes, then recovers',
    description: 'Adapter B (receiver) crashes after processing some requests. It restarts and reloads dialog state from the database. Subsequent requests are processed correctly, and duplicate detection still works.',
    outcome: 'State recovered, no work repeated',
    watch: ['Receiver crashes', 'State reloaded', 'Processing continues'],
    Icon: LifeBuoy,
    tone: 'cyan',
    protocol: 'MCP',
  },
  {
    id: 5,
    title: 'Mid-Task Disconnect + Adapter A Restart → Resume',
    tagline: 'Sender crashes mid-task, recovers',
    description: 'Adapter A (sender) crashes partway through a task and loses its memory. It restarts, reloads the unfinished dialog from the database with the same task_id, and continues sending requests without repeating completed work.',
    outcome: 'Task identity preserved, resumed',
    watch: ['Sender crashes', 'Task identity preserved', 'Recovered'],
    Icon: Shuffle,
    tone: 'sky',
    protocol: 'A2A',
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

/** Icons that the presentation layer resolves by name, kept in one place. */
export const ICON_MAP = {
  send: 'send',
  server: 'server',
  network: 'network',
  database: 'database',
  wifi: 'wifi',
  tasks: 'tasks',
  copy: 'copy',
  recovery: 'recovery',
  zap: Zap,
  shuffle: Shuffle,
  rotate: RotateCcw,
  fingerprint: Fingerprint,
  radar: Radar,
  lifeBuoy: LifeBuoy,
  heartPulse: HeartPulse,
  duplicate: Copy,
};

/** Engine timings (ms). Kept in one place so the demo stays watchable. */
export const TIMING = {
  QUIET_MS: 700,
  ACK_MS: 600,
  NACK_INTERVAL: 650,
  RTO: 1500,
  RETRANSMIT_MAX: 3,
  WATCHDOG_TICK: 200,
  TELEMETRY_TICK: 1000,
  MAX_RETRANSMITS: 3,
};
