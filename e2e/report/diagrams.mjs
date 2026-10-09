/**
 * npm run report:diagrams — writes docs/assets/diagrams/{architecture,lifecycle,sequence}.svg
 *
 * Hand-laid-out SVG generated from data in this file (no extra dependency, fully
 * offline and deterministic).  Before writing, the data is VERIFIED against the
 * code: lifecycle states and transitions are parsed from
 * backend/src/types/index.ts, and every component / method named in a diagram
 * must exist in the source file it points to.  Any mismatch → exit code 1.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../support/backend.js';

const OUT = path.join(REPO_ROOT, 'docs', 'assets', 'diagrams');
const src = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const checks = [];
function verify(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok), detail });
}

// ---------------------------------------------------------------- SVG helpers
const FONT = "Segoe UI, Helvetica, Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PALETTE = {
  ui: ['#e0f2fe', '#0369a1'], api: ['#ede9fe', '#6d28d9'], rt: ['#f1f5f9', '#334155'],
  a: ['#dbeafe', '#1d4ed8'], net: ['#fef3c7', '#b45309'], b: ['#ede9fe', '#6d28d9'],
  dm: ['#dcfce7', '#15803d'], repo: ['#ecfeff', '#0e7490'], db: ['#cffafe', '#0e7490'],
  initial: ['#f1f5f9', '#475569'], live: ['#dbeafe', '#1d4ed8'], ok: ['#dcfce7', '#15803d'],
  rec: ['#cffafe', '#0e7490'], bad: ['#ffe4e6', '#be123c'],
};

function svgDoc(width, height, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#334155"/></marker>
  <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#be123c"/></marker>
</defs>
<rect width="100%" height="100%" fill="#ffffff"/>
<g font-family="${FONT}" fill="#0f172a">
${body}
</g>
</svg>
`;
}

function box(x, y, w, h, kind, title, lines = [], { rx = 10, titleSize = 15 } = {}) {
  const [fill, stroke] = PALETTE[kind];
  const out = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`];
  const total = 1 + lines.length;
  const lineH = 17;
  let ty = y + h / 2 - ((total - 1) * lineH) / 2 + 5;
  out.push(`<text x="${x + w / 2}" y="${ty}" text-anchor="middle" font-size="${titleSize}" font-weight="700" fill="${stroke}">${esc(title)}</text>`);
  for (const line of lines) {
    ty += lineH;
    out.push(`<text x="${x + w / 2}" y="${ty}" text-anchor="middle" font-size="12.5" fill="#334155">${esc(line)}</text>`);
  }
  return out.join('\n');
}

function arrow(x1, y1, x2, y2, label, { red = false, dashed = false, labelDx = 0, labelDy = -7, anchor = 'middle', size = 12 } = {}) {
  const color = red ? '#be123c' : '#334155';
  const out = [`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.6"${dashed ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#${red ? 'arrow-red' : 'arrow'})"/>`];
  if (label) {
    const lx = (x1 + x2) / 2 + labelDx;
    const ly = (y1 + y2) / 2 + labelDy;
    out.push(`<text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="${size}" fill="${color}">${esc(label)}</text>`);
  }
  return out.join('\n');
}

const text = (x, y, s, { size = 13, weight = 400, anchor = 'start', color = '#334155', italic = false } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${color}"${italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`;

// ---------------------------------------------------------------- 1. architecture
// Each component names the source that defines it; verified below.
const COMPONENTS = [
  { id: 'ui', file: 'Front/frontend/src/api/useBackendEngine.js', name: 'useBackendEngine', kind: 'function' },
  { id: 'api', file: 'backend/src/app.ts', name: 'createApp', kind: 'function' },
  { id: 'rt', file: 'backend/src/runtime/SimulationRuntime.ts', name: 'SimulationRuntime', kind: 'class' },
  { id: 'a', file: 'backend/src/adapters/AdapterA.ts', name: 'AdapterA', kind: 'class' },
  { id: 'net', file: 'backend/src/runtime/ObservedTransport.ts', name: 'ObservedTransport', kind: 'class' },
  { id: 'net2', file: 'backend/src/adapters/Transport.ts', name: 'Transport', kind: 'class' },
  { id: 'b', file: 'backend/src/adapters/AdapterB.ts', name: 'AdapterB', kind: 'class' },
  { id: 'se', file: 'backend/src/adapters/AdapterB.ts', name: 'InMemorySideEffectTracker', kind: 'class' },
  { id: 'dm', file: 'backend/src/services/DialogManager.ts', name: 'DialogManager', kind: 'class' },
  { id: 'r1', file: 'backend/src/repositories/DialogRepository.ts', name: 'DialogRepository', kind: 'class' },
  { id: 'r2', file: 'backend/src/repositories/RequestRepository.ts', name: 'RequestRepository', kind: 'class' },
  { id: 'r3', file: 'backend/src/repositories/OutboundRequestRepository.ts', name: 'OutboundRequestRepository', kind: 'class' },
  { id: 'db', file: 'backend/src/db/index.ts', name: 'persistToDisk', kind: 'function' },
];
for (const c of COMPONENTS) {
  const re = new RegExp(`export (?:async )?${c.kind === 'class' ? 'class' : 'function'} ${c.name}\\b`);
  verify(`architecture: ${c.name} exists`, re.test(src(c.file)), c.file);
}
const schemaSql = src('backend/src/db/schema.sql');
for (const t of ['dialogs', 'requests', 'outbound_requests']) {
  verify(`architecture: table ${t}`, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`).test(schemaSql), 'backend/src/db/schema.sql');
}

const architecture = svgDoc(1040, 660, 'Nighthawks architecture', [
  text(20, 30, 'Nighthawks PS-021 — architecture (one Node.js process, one SQLite file)', { size: 17, weight: 700, color: '#0f172a' }),
  box(20, 60, 230, 86, 'ui', 'React dashboard', ['useBackendEngine (polls)', 'ManualControls · Vite proxy']),
  box(310, 60, 210, 86, 'api', 'HTTP API (Express)', ['createApp · /api/*', 'dialogs · scenarios · restart']),
  box(580, 60, 440, 86, 'rt', 'SimulationRuntime', ['one lock · event log · scenario runner', 'restart = rebuild everything from the file']),
  arrow(250, 103, 310, 103, 'REST'),
  arrow(520, 103, 580, 103, ''),
  // adapters row
  box(20, 220, 260, 96, 'a', 'Adapter A (initiator)', ['startDialog · sendRequest · retryRequest', 'recover · completeDialog · failDialog']),
  box(370, 220, 270, 96, 'net', 'Transport (in-process)', ['ObservedTransport extends Transport', 'fault: drop request / drop reply']),
  box(730, 220, 290, 96, 'b', 'Adapter B (receiver)', ['handleRequest: correlate → dedup →', 'terminal check → work → record']),
  arrow(860, 146, 860, 220, 'builds & drives both adapters', { labelDx: 8, anchor: 'start' }),
  arrow(640, 146, 230, 220, ''),
  arrow(280, 252, 370, 252, 'request', { labelDy: -8 }),
  arrow(370, 290, 280, 290, 'response', { labelDy: 17 }),
  text(505, 334, 'request = (dialog_id, task_id, seq, payload) · response = ok | duplicate | error', { anchor: 'middle', size: 11, color: '#475569' }),
  arrow(640, 252, 730, 252, 'deliver'),
  arrow(730, 290, 640, 290, 'answer', { labelDy: 17 }),
  box(735, 360, 200, 54, 'b', 'Mock side effect', ['InMemorySideEffectTracker'], { titleSize: 13 }),
  arrow(835, 316, 835, 360, ''),
  // domain + storage
  box(330, 380, 330, 70, 'dm', 'DialogManager', ['correlate · lifecycle transitions · task identity']),
  arrow(150, 316, 360, 380, 'state', { labelDx: -30 }),
  arrow(760, 316, 640, 380, 'correlate / transition', { labelDx: -62, labelDy: 16 }),
  box(20, 500, 300, 64, 'repo', 'OutboundRequestRepository', ['outbound_requests — Adapter A send log'], { titleSize: 14 }),
  box(360, 500, 270, 64, 'repo', 'DialogRepository', ['dialogs — identity + state'], { titleSize: 14 }),
  box(670, 500, 350, 64, 'repo', 'RequestRepository', ['requests — Adapter B processed records (dedup)'], { titleSize: 14 }),
  arrow(100, 316, 100, 500, 'send log', { labelDx: 8, anchor: 'start' }),
  arrow(495, 450, 495, 500, ''),
  arrow(985, 316, 985, 500, 'dedup ledger', { labelDx: -6, labelDy: 50, anchor: 'end' }),
  box(330, 596, 380, 54, 'db', 'SQLite file (sql.js)', ['persistToDisk() after every write'], { titleSize: 14 }),
  arrow(170, 564, 380, 596, ''),
  arrow(495, 564, 495, 596, ''),
  arrow(845, 564, 660, 596, ''),
].join('\n'));

// ---------------------------------------------------------------- 2. lifecycle
const types = src('backend/src/types/index.ts');
const parsedStates = /LIFECYCLE_STATES = \[([^\]]*)\]/.exec(types)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
const tableSrc = types.slice(types.indexOf('VALID_TRANSITIONS'), types.indexOf('};', types.indexOf('VALID_TRANSITIONS')));
const parsedEdges = [];
for (const from of parsedStates) {
  const row = new RegExp(`${from}:\\s*\\[([^\\]]*)\\]`).exec(tableSrc)[1];
  for (const to of row.match(/'(\w+)'/g)?.map((s) => s.slice(1, -1)) ?? []) parsedEdges.push(`${from}->${to}`);
}

const STATE_POS = {
  INITIATED: { x: 170, y: 200, kind: 'initial' },
  PROCESSING: { x: 520, y: 200, kind: 'live' },
  COMMITTED: { x: 880, y: 110, kind: 'ok' },
  RECOVERED: { x: 880, y: 290, kind: 'rec' },
  FAILED: { x: 520, y: 420, kind: 'bad' },
};
const SW = 170;
const SH = 56;
const EDGES = [
  { from: 'INITIATED', to: 'PROCESSING', label: 'B processes the first new seq', geom: [255, 200, 435, 200], opts: { labelDy: -10, size: 11.5 } },
  { from: 'INITIATED', to: 'FAILED', label: 'retry budget used up / failDialog', geom: [200, 228, 440, 404], opts: { labelDx: -78, labelDy: 18, size: 11.5 } },
  { from: 'PROCESSING', to: 'COMMITTED', label: 'completeDialog · restored = false', geom: [605, 184, 795, 122], opts: { labelDx: -10, labelDy: -14, anchor: 'end', size: 11.5 } },
  { from: 'PROCESSING', to: 'RECOVERED', label: 'completeDialog · restored = true', geom: [605, 216, 795, 278], opts: { labelDx: -12, labelDy: 40, anchor: 'middle', size: 11.5 } },
  { from: 'PROCESSING', to: 'FAILED', label: 'retry budget used up / failDialog', geom: [520, 228, 520, 392], opts: { labelDx: 8, labelDy: 48, anchor: 'start', size: 11.5 } },
];
const drawnEdges = EDGES.map((e) => `${e.from}->${e.to}`);
verify('lifecycle: states = LIFECYCLE_STATES', JSON.stringify(Object.keys(STATE_POS)) === JSON.stringify(parsedStates), parsedStates.join(', '));
verify('lifecycle: transitions = VALID_TRANSITIONS', JSON.stringify([...drawnEdges].sort()) === JSON.stringify([...parsedEdges].sort()), parsedEdges.join(', '));
const terminal = /TERMINAL_STATES[^=]*= new Set\(\[([^\]]*)\]/.exec(types)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
verify('lifecycle: terminal states', JSON.stringify(terminal) === JSON.stringify(['COMMITTED', 'RECOVERED', 'FAILED']), terminal.join(', '));
const adapterA = src('backend/src/adapters/AdapterA.ts');
verify('lifecycle: completeDialog chooses RECOVERED when restored', /dialog\.restored\s*\?\s*this\.dialogManager\.transitionToRecovered/.test(adapterA), 'AdapterA.completeDialog');
verify('lifecycle: Adapter B moves INITIATED → PROCESSING', /if \(dialog\.state === 'INITIATED'\)\s*\{\s*this\.dialogManager\.transition\(request\.dialog_id, 'PROCESSING'\)/.test(src('backend/src/adapters/AdapterB.ts')), 'AdapterB.handleRequest');

const lifecycle = svgDoc(1000, 524, 'Nighthawks lifecycle state machine', [
  text(20, 30, 'Lifecycle — exactly the five backend states (backend/src/types/index.ts)', { size: 17, weight: 700, color: '#0f172a' }),
  `<circle cx="34" cy="200" r="9" fill="#0f172a"/>`,
  text(22, 176, 'startDialog', { size: 11.5 }),
  arrow(43, 200, 85, 200, ''),
  ...Object.entries(STATE_POS).map(([name, p]) => box(p.x - SW / 2, p.y - SH / 2, SW, SH, p.kind, name, [], { rx: 28, titleSize: 15 })),
  ...EDGES.map((e) => arrow(...e.geom, e.label, e.opts)),
  text(880, 156, 'terminal', { anchor: 'middle', size: 11.5, italic: true, color: '#15803d' }),
  text(880, 336, 'terminal', { anchor: 'middle', size: 11.5, italic: true, color: '#0e7490' }),
  text(520, 466, 'terminal', { anchor: 'middle', size: 11.5, italic: true, color: '#be123c' }),
  text(20, 492, 'completeDialog needs every seq ACKED (otherwise 409 PENDING_REQUESTS); retry budget = maxAttempts (default 5).', { size: 11.5, color: '#475569' }),
  text(20, 510, 'Terminal states accept no new work; a retry of an already-processed seq still returns the stored answer.', { size: 11.5, color: '#475569' }),
].join('\n'));

// ---------------------------------------------------------------- 3. sequence
for (const m of ['sendRequest', 'retryRequest', 'recover', 'completeDialog']) {
  verify(`sequence: AdapterA.${m} exists`, new RegExp(`\\b${m}\\(`).test(adapterA), 'backend/src/adapters/AdapterA.ts');
}
verify('sequence: restart rebuilds from the file', /private async doRestart[\s\S]*?this\.teardown\(\);\s*this\.boot\(\);[\s\S]*?recoverAndEmit\(\)/.test(src('backend/src/runtime/SimulationRuntime.ts')), 'SimulationRuntime.doRestart');
verify('sequence: dedup returns stored result as duplicate', /status:\s*'duplicate',\s*result:\s*JSON\.parse\(existing\.result\)/.test(src('backend/src/adapters/AdapterB.ts')), 'AdapterB.handleRequest');

const LANES = [
  { name: 'Adapter A', x: 140, kind: 'a' },
  { name: 'Transport', x: 400, kind: 'net' },
  { name: 'Adapter B', x: 660, kind: 'b' },
  { name: 'SQLite file', x: 900, kind: 'db' },
];
const lane = (n) => LANES.find((l) => l.name === n).x;
let y = 110;
const step = (h = 38) => { y += h; return y; };
const seq = [];
const msg = (from, to, label, opts = {}) => seq.push(arrow(lane(from) + (lane(to) > lane(from) ? 6 : -6), step(opts.h), lane(to) + (lane(to) > lane(from) ? -6 : 6), y, label, { size: 12, ...opts }));
const note = (label, color = '#334155', h = 34) => {
  step(h);
  seq.push(`<rect x="60" y="${y - 18}" width="920" height="26" rx="6" fill="#f8fafc" stroke="#cbd5e1"/>`);
  seq.push(text(520, y, label, { anchor: 'middle', size: 12.5, weight: 600, color }));
};

note('Scenario 5 shape · task T1, dialog D1 · seq 1 and 2 already processed and ACKED', '#0f172a', 10);
msg('Adapter A', 'SQLite file', 'send log (D1, seq 3) PENDING — written BEFORE sending');
msg('Adapter A', 'Transport', 'request (D1, T1, seq 3, payload)');
msg('Transport', 'Adapter B', 'deliver');
msg('Adapter B', 'SQLite file', 'correlate D1/T1 · (D1,3) not found → do the work → record (D1,3)');
msg('Adapter B', 'Transport', 'ok + result');
msg('Transport', 'Adapter A', '✕ REPLY LOST — work done, A does not know (seq 3 stays PENDING)', { red: true });
note('Restart Adapter A → the whole process is rebuilt from the SQLite file (A and B share one store)', '#b45309');
msg('Adapter A', 'SQLite file', 'recover(): restored = true · next_seq 4 · pending [3]');
msg('Adapter A', 'Transport', 'retry (D1, T1, seq 3) — same ids, stored payload');
msg('Transport', 'Adapter B', 'deliver');
msg('Adapter B', 'SQLite file', '(D1,3) found → work NOT repeated');
msg('Adapter B', 'Adapter A', 'DUPLICATE + stored result', { labelDy: -7 });
msg('Adapter A', 'SQLite file', '(D1, seq 3) ACKED');
msg('Adapter A', 'Adapter B', 'send seq 4 (next_seq from durable state) → processed once → ok');
msg('Adapter A', 'SQLite file', 'completeDialog → RECOVERED (restored = true, nothing PENDING)');
const bottom = y + 30;

const sequence = svgDoc(1040, bottom + 20, 'Nighthawks sequence: reply lost, restart, recover, resume', [
  text(20, 30, 'Reply lost → restart → recover → retry = duplicate → resume → RECOVERED', { size: 17, weight: 700, color: '#0f172a' }),
  ...LANES.map((l) => box(l.x - 80, 50, 160, 40, l.kind, l.name, [], { titleSize: 14 })),
  ...LANES.map((l) => `<line x1="${l.x}" y1="90" x2="${l.x}" y2="${bottom}" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 4"/>`),
  ...seq,
].join('\n'));

// ---------------------------------------------------------------- write
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.label}  (${c.detail})`);
if (failed.length) {
  console.error(`\n${failed.length} diagram check(s) failed — diagrams NOT written`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
for (const [name, svg] of [['architecture', architecture], ['lifecycle', lifecycle], ['sequence', sequence]]) {
  writeFileSync(path.join(OUT, `${name}.svg`), svg, 'utf8');
  console.log(`wrote docs/assets/diagrams/${name}.svg`);
}
console.log(`\nlifecycle verified against backend/src/types/index.ts: states [${parsedStates.join(', ')}]; transitions [${parsedEdges.join(', ')}]`);
