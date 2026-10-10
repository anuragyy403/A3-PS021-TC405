import { useMemo, useState } from 'react';
import { Eraser, Search } from 'lucide-react';
import { narrate } from '../lib/narrate.js';
import { Empty, IconTile, Pill } from './ui/Glass.jsx';
import Icon from './ui/icons.jsx';
import { TONE_CLASSES } from './ui/tokens.js';

/** Filter chips, labelled the way a non-technical viewer would search. */
const FILTERS = [
  { id: 'all', label: 'Everything', match: () => true },
  { id: 'problems', label: 'Problems', match: (entry) => entry.kind === 'error' },
  { id: 'recovered', label: 'Being fixed', match: (entry) => entry.kind === 'recovery' },
  { id: 'blocked', label: 'Duplicates', match: (entry) => entry.kind === 'duplicate' },
  { id: 'good', label: 'Successes', match: (entry) => entry.kind === 'success' },
];

const VISIBLE_ROWS = 60;

/**
 * The activity feed.
 *
 * Every line is a sentence a first-time viewer can read without being told what
 * any of the words mean, so this panel doubles as the narration of a demo. The
 * precise technical record is still one click away behind each row.
 */
export default function ActivityFeed({ logs, onClear }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(null);

  const activeFilter = FILTERS.find((item) => item.id === filter) ?? FILTERS[0];

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const spoken = logs.map((entry) => ({ entry, text: narrate(entry) }));
    const filtered = spoken.filter(({ entry, text }) => {
      if (!activeFilter.match(entry)) return false;
      if (!needle) return true;
      return (
        text.headline.toLowerCase().includes(needle) ||
        (text.detail ?? '').toLowerCase().includes(needle) ||
        String(entry.msg).toLowerCase().includes(needle)
      );
    });
    return filtered.slice(-VISIBLE_ROWS).reverse();
  }, [activeFilter, logs, query]);

  const problemCount = logs.filter((entry) => entry.kind === 'error').length;

  return (
    <section className="glass flex min-h-0 flex-col overflow-hidden">
      <span className="glass-sheen" aria-hidden="true" />

      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 pb-3 pt-5">
        <IconTile name="signal" tone={problemCount ? 'warn' : 'info'} size="md" />
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-white">What is happening</h2>
          <p className="mt-0.5 text-[12.5px] text-slate-500">A plain-language record of every packet, fault and fix.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="relative">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the activity"
              aria-label="Search the activity feed"
              className="field w-[190px] py-2 pl-8 text-[12.5px]"
            />
          </label>
          <button type="button" className="btn-subtle px-3 py-2" onClick={onClear} title="Clear the activity feed">
            <Eraser size={14} />
            <span className="hidden sm:inline">Clear</span>
          </button>
        </div>
      </header>

      <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-6 pb-3">
        {FILTERS.map((item) => {
          const isActive = item.id === filter;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold transition-all duration-200 ${
                isActive
                  ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
                  : 'border-white/[0.07] bg-white/[0.02] text-slate-400 hover:border-white/15 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {rows.length === 0 ? (
          <Empty
            icon={logs.length ? 'search' : 'signal'}
            title={logs.length ? 'Nothing matches that search' : 'No activity yet'}
            hint={
              logs.length
                ? 'Try a different word, or switch back to Everything.'
                : 'Run one of the demos above, or send a few packets yourself, and every step will be explained here.'
            }
          />
        ) : (
          <ol className="space-y-0.5">
            {rows.map(({ entry, text }) => {
              const t = TONE_CLASSES[text.tone] ?? TONE_CLASSES.info;
              const isOpen = expanded === entry.id;
              return (
                <li key={entry.id} className="animate-feed-in">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : entry.id)}
                    aria-expanded={isOpen}
                    className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-200 ${
                      isOpen ? `${t.bg}` : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 ${t.bg} ${t.ring}`}>
                      <Icon name={text.Icon} size={13} className={t.text} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-snug text-slate-100">{text.headline}</span>
                      {text.detail ? <span className="mt-0.5 block text-[12px] leading-relaxed text-slate-500">{text.detail}</span> : null}
                    </span>
                    <span className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
                      <span className="tabular text-[10.5px] font-medium text-slate-600">{entry.clock}</span>
                      <Pill tone={text.tone}>{text.source}</Pill>
                    </span>
                  </button>

                  {isOpen ? (
                    <div className="mx-3 mb-2 rounded-xl border border-white/[0.07] bg-night-950/60 px-3.5 py-3">
                      <p className="overline mb-1.5">Technical record</p>
                      <p className="font-mono text-[11.5px] leading-relaxed text-sky-200/90">{String(entry.msg)}</p>
                      {entry.meta ? (
                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                          {Object.entries(entry.meta)
                            .filter(([, value]) => typeof value !== 'object')
                            .slice(0, 8)
                            .map(([key, value]) => (
                              <div key={key} className="contents">
                                <dt className="text-slate-600">{key}</dt>
                                <dd className="truncate text-slate-400">{String(value)}</dd>
                              </div>
                            ))}
                        </dl>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {logs.length > VISIBLE_ROWS ? (
        <p className="border-t border-white/[0.06] px-6 py-2.5 text-[11px] text-slate-600">
          Showing the most recent {VISIBLE_ROWS} of {logs.length} entries.
        </p>
      ) : null}
    </section>
  );
}
