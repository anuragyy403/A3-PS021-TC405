/** Presentation helpers: clocks, counters, JSON tooling and file exports. */

export const pad = (value, size = 2) => String(value).padStart(size, '0');

/** Wall-clock stamp used on every log line and scenario step. */
export function clockStamp(at = Date.now()) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function isoStamp(at = Date.now()) {
  return new Date(at).toISOString();
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${pad(seconds)}s`;
}

export const compactNumber = (value) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value ?? 0);

/**
 * Parses JSON and reports the failing line/column so the payload studio can
 * point at the offending character instead of only showing a V8 message.
 */
export function parseJsonSafe(text) {
  if (text.trim() === '') return { ok: false, error: 'payload is empty', position: null, value: null };
  try {
    return { ok: true, error: null, position: null, value: JSON.parse(text) };
  } catch (error) {
    const match = /position (\d+)/.exec(error.message);
    const position = match ? Number(match[1]) : null;
    let line = null;
    let column = null;
    if (position !== null) {
      const upTo = text.slice(0, position);
      line = upTo.split('\n').length;
      column = position - upTo.lastIndexOf('\n');
    }
    return {
      ok: false,
      error: error.message.replace(/^JSON\.parse: /, '').replace(/ in JSON at position \d+$/, ''),
      position,
      line,
      column,
      value: null,
    };
  }
}

/** Naive but dependency-free JSON syntax highlighter for the metadata viewer. */
export function highlightJson(value) {
  const json = JSON.stringify(value, null, 2) ?? 'null';
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'json-num';
      if (match.startsWith('"')) cls = match.endsWith(':') ? 'json-key' : 'json-str';
      else if (match === 'true' || match === 'false') cls = 'json-bool';
      else if (match === 'null') cls = 'json-null';
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

/** Triggers a client-side download; returns false when the browser blocks it. */
export function downloadFile(filename, mimeType, contents) {
  try {
    const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

const CSV_COLUMNS = [
  'timestamp',
  'clock',
  'tx_id',
  'kind',
  'layer',
  'dialog_id',
  'task_id',
  'protocol',
  'sequence_no',
  'expected_sequence',
  'side_effects',
  'suppressed',
  'attempt',
  'latency_ms',
  'message',
  'metadata',
];

export function logsToCsv(logs) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = logs.map((entry) =>
    [
      entry.ts,
      entry.clock,
      entry.tx,
      entry.kind,
      entry.layer,
      entry.dialogId,
      entry.meta?.task_id,
      entry.meta?.protocol,
      entry.meta?.sequence_no,
      entry.meta?.expected_sequence,
      entry.meta?.side_effects,
      entry.meta?.suppressed,
      entry.meta?.attempt,
      entry.meta?.latency_ms,
      entry.msg,
      entry.meta ? JSON.stringify(entry.meta) : '',
    ]
      .map(escape)
      .join(','),
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

export const logsToJson = (logs, extra = {}) =>
  JSON.stringify(
    {
      exported_at: isoStamp(),
      system: 'Nighthawks · Adapter A dialog correlation engine',
      problem_statement: 'AIORI-3 / PS-021 — Experimental Dialog Correlation and Recovery Across Agent Adapters',
      metrics: extra.metrics ?? null,
      entries: logs,
    },
    null,
    2,
  );