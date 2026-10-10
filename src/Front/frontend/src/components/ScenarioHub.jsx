import { SCENARIOS, SCENARIO_TONE } from '../lib/constants.js';
import { IconTile, Pill, ProgressBar } from './ui/Glass.jsx';
import { TONE_CLASSES } from './ui/tokens.js';

/**
 * Card themes use their own colour names (emerald, orange, ...), while the shared
 * tone tokens are semantic (good, warn, ...). This maps between the two so a
 * card and its inline progress bar always share one colour.
 */
const FEED_TONE = {
  emerald: 'good',
  amber: 'warn',
  orange: 'warn',
  sky: 'info',
  violet: 'duplicate',
};

/** Seconds, rendered compactly, shown next to a finished demo. */
function shortDuration(ms) {
  if (!ms && ms !== 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One demo card.
 *
 * The colour of the card, the dot, the button and the result badge all come from
 * the scenario's tone, so a viewer can learn "amber means the network shuffled
 * something" once and then read the whole hub by colour alone.
 */
function ScenarioCard({ scenario, result, active, onRun, disabled }) {
  const theme = SCENARIO_TONE[scenario.tone];
  const Icon = scenario.Icon;
  const isActive = active === scenario.id;
  const passed = result?.status === 'passed';

  return (
    <article
      className={`glass group relative flex flex-col gap-4 p-5 transition-all duration-300 ${
        isActive ? `${theme.border} ${theme.bg} ${theme.glow}` : 'hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.055]'
      }`}
    >
      <span className="glass-sheen" aria-hidden="true" />

      {/* Colour rail down the leading edge of the card. */}
      <span
        className={`absolute inset-y-5 left-0 w-[3px] rounded-full bg-gradient-to-b ${theme.grad} transition-opacity duration-300 ${
          isActive ? 'opacity-100' : 'opacity-45 group-hover:opacity-80'
        }`}
        aria-hidden="true"
      />

      <div className="flex items-start gap-3">
        <span
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ring-1 ${theme.bg} ${theme.ring} ${isActive ? theme.glow : ''}`}
        >
          <Icon size={19} className={theme.text} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md text-[10.5px] font-bold ${theme.bg} ${theme.text}`}>
              {scenario.id}
            </span>
            <h3 className="truncate text-[14.5px] font-bold leading-tight text-white">{scenario.title}</h3>
          </div>
          <p className={`mt-1 text-[12px] font-medium leading-snug ${theme.text}`}>{scenario.tagline}</p>
        </div>
      </div>

      <p className="text-[12.5px] leading-relaxed text-slate-400">{scenario.description}</p>

      <div className="flex flex-wrap gap-1.5">
        {scenario.watch.map((item) => (
          <span
            key={item}
            className="rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-slate-400"
          >
            {item}
          </span>
        ))}
      </div>

      {isActive ? <ProgressBar indeterminate tone={FEED_TONE[scenario.tone] ?? 'info'} /> : null}

      <div className="mt-auto flex items-center gap-2.5">
        <button
          type="button"
          className={`btn flex-1 ${isActive ? 'btn-ghost' : 'btn-primary'}`}
          onClick={() => onRun(scenario.id)}
          disabled={disabled && !isActive}
        >
          {isActive ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/25 border-t-white" />
              Running...
            </>
          ) : (
            <>
              <Icon size={15} />
              Run demo
            </>
          )}
        </button>

        {result ? (
          <Pill tone={passed ? 'good' : 'bad'} icon={passed ? 'check' : 'x'}>
            {passed ? `Passed in ${shortDuration(result.durationMs)}` : 'Failed'}
          </Pill>
        ) : (
          <Pill tone="idle">Not run yet</Pill>
        )}
      </div>
    </article>
  );
}

/**
 * The demo hub.
 *
 * Five cards, one per mandatory scenario. Everything needed to explain a run is
 * on the card itself: what it does, what you will see, and whether it passed.
 */
export default function ScenarioHub({ simulation, scenarioResults, activeScenario, onRun, onRunAll }) {
  const running = Boolean(simulation.running);
  const executed = Object.values(scenarioResults);
  const passedCount = executed.filter((result) => result.status === 'passed').length;
  const allPassed = executed.length === SCENARIOS.length && passedCount === SCENARIOS.length;

  // The engine clears `running` when a demo ends, so the most recent result is
  // what identifies the run being summarised.
  const lastRunId = executed.length ? executed.reduce((best, result) => (result.at > best.at ? result : best)).id : null;

  const activeSteps = running ? simulation.steps.slice(-4) : [];

  return (
    <section className="glass overflow-hidden">
      <span className="glass-sheen" aria-hidden="true" />

      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 pb-4 pt-5">
        <IconTile name="sparkles" tone={allPassed ? 'good' : 'info'} size="md" pulse={running} />
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-white">Demonstrations</h2>
          <p className="mt-0.5 text-[12.5px] text-slate-500">
            Five fault scenarios. Press <span className="font-semibold text-slate-300">Run demo</span> on any card and watch the pipeline above react.
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          {executed.length ? (
            <Pill tone={allPassed ? 'good' : 'warn'}>
              {passedCount} of {SCENARIOS.length} passed
            </Pill>
          ) : null}
          <button type="button" className="btn-ghost" onClick={onRunAll} disabled={running}>
            Run all five
          </button>
        </div>
      </header>

      {/* Narration of the running demo, in plain sentences. */}
      {running && activeSteps.length ? (
        <div className="mx-6 mb-4 rounded-2xl border border-sky-400/20 bg-sky-500/[0.07] px-4 py-3">
          <p className="overline mb-2 text-sky-300/80">Step by step</p>
          <ol className="space-y-1.5">
            {activeSteps.map((step, index) => (
              <li key={`${step.at}-${index}`} className="animate-feed-in flex items-start gap-2.5 text-[12.5px] leading-snug">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                    step.tone === 'warn' ? 'bg-amber-400' : step.tone === 'head' ? 'bg-sky-400' : 'bg-slate-500'
                  }`}
                />
                <span className={step.tone === 'head' ? 'font-semibold text-white' : 'text-slate-300'}>{step.text}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="grid gap-4 px-6 pb-6 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {SCENARIOS.map((scenario) => (
          <ScenarioCard
            key={scenario.id}
            scenario={scenario}
            result={scenarioResults[scenario.id]}
            active={activeScenario ?? (running ? simulation.running : null)}
            onRun={onRun}
            disabled={running}
          />
        ))}
      </div>

      {/* Completed-run summary strip. */}
      {simulation.status === 'passed' || simulation.status === 'failed' ? (
        <div
          className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.06] px-6 py-3.5 ${
            simulation.status === 'passed' ? TONE_CLASSES.good.bg : TONE_CLASSES.bad.bg
          }`}
        >
          <IconTile
            name={simulation.status === 'passed' ? 'check' : 'x'}
            tone={simulation.status === 'passed' ? 'good' : 'bad'}
            size="sm"
          />
          <p className="text-[12.5px] font-medium text-slate-200">
            {simulation.status === 'passed'
              ? `Demo ${lastRunId ?? ''} finished: all ${simulation.assertions.length} checks passed in ${shortDuration(simulation.durationMs)}.`
              : `Demo ${lastRunId ?? ''} finished with ${simulation.assertions.filter((row) => !row.ok).length} failed check(s).`}
          </p>
          {simulation.assertions.length ? (
            <details className="ml-auto">
              <summary className="cursor-pointer list-none text-[12px] font-semibold text-slate-300 underline-offset-2 hover:underline">
                Show the {simulation.assertions.length} checks
              </summary>
              <ul className="mt-2 space-y-1">
                {simulation.assertions.map((row, index) => (
                  <li key={`${row.label}-${index}`} className="flex items-start gap-2 text-[12px] leading-snug">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${row.ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                    <span className="text-slate-300">
                      {row.label}
                      {row.detail ? <span className="text-slate-500"> — {row.detail}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
