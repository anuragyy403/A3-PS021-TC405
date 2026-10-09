import Icon from './icons.jsx';
import { tone } from './tokens.js';

const TILE_SIZES = {
  sm: { box: 'h-8 w-8 rounded-lg', glyph: 14 },
  md: { box: 'h-10 w-10 rounded-xl', glyph: 17 },
  lg: { box: 'h-12 w-12 rounded-2xl', glyph: 20 },
};

/**
 * The standard glass container.
 *
 * `as` lets a caller change the rendered element while keeping identical chrome,
 * `pad` controls the internal breathing room, and `actions` sits in the header on
 * the opposite side to the title.
 */
export function GlassPanel({ as: Tag = 'section', title, subtitle, icon, iconTone = 'info', actions, children, className = '', bodyClassName = '', pad = true }) {
  return (
    <Tag className={`glass flex flex-col overflow-hidden ${className}`}>
      <span className="glass-sheen" aria-hidden="true" />
      {title ? (
        <header className="flex flex-wrap items-center gap-3 px-6 pb-4 pt-5">
          {icon ? <IconTile name={icon} tone={iconTone} /> : null}
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-white">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[12.5px] leading-snug text-slate-500">{subtitle}</p> : null}
          </div>
          {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`flex-1 ${pad ? 'px-6 pb-6' : ''} ${bodyClassName}`}>{children}</div>
    </Tag>
  );
}

/** Rounded icon tile with a tinted background and ring. */
export function IconTile({ name, tone: toneName = 'info', size = 'md', pulse = false, className = '' }) {
  const t = tone(toneName);
  const { box, glyph } = TILE_SIZES[size] ?? TILE_SIZES.md;

  return (
    <span
      className={`grid shrink-0 place-items-center ring-1 ${box} ${t.bg} ${t.ring} ${pulse ? 'animate-ring-out' : ''} ${className}`}
      aria-hidden="true"
    >
      <Icon name={name} size={glyph} className={t.text} />
    </span>
  );
}

/** Compact status pill, with a leading dot or icon. */
export function Pill({ tone: toneName = 'idle', children, icon, className = '', pulse = false }) {
  const t = tone(toneName);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${t.bg} ${t.border} ${t.text} ${
        pulse ? 'animate-breathe' : ''
      } ${className}`}
    >
      {icon ? <Icon name={icon} size={12} /> : <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
      {children}
    </span>
  );
}

/** Thin progress track, used by the running demo cards. */
export function ProgressBar({ value, tone: toneName = 'info', indeterminate = false, className = '' }) {
  const t = tone(toneName);

  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07] ${className}`}>
      {indeterminate ? (
        <div className={`h-full w-1/3 rounded-full ${t.dot} animate-sheen`} />
      ) : (
        <div
          className={`h-full rounded-full ${t.dot} transition-[width] duration-500 ease-out`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      )}
    </div>
  );
}

/** Small labelled figure used inside panels. */
export function Figure({ label, value, sub, tone: toneName = 'info' }) {
  const t = tone(toneName);

  return (
    <div className="min-w-0">
      <div className="overline">{label}</div>
      <div className={`tabular mt-1 text-lg font-bold leading-none ${t.text}`}>{value}</div>
      {sub ? <div className="mt-1 text-[11.5px] leading-snug text-slate-500">{sub}</div> : null}
    </div>
  );
}

/** Empty-state block. */
export function Empty({ icon = 'info', title, hint, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.03]">
        <Icon name={icon} size={20} className="text-slate-500" />
      </span>
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint ? <p className="max-w-md text-[12.5px] leading-relaxed text-slate-500">{hint}</p> : null}
      {action}
    </div>
  );
}
