import { useCallback, useMemo, useState } from 'react';
import { ENGINE, useEngine } from './api/engine.js';
import { SCENARIOS } from './lib/constants.js';
import { Pill } from './components/ui/Glass.jsx';
import { TONE_CLASSES } from './components/ui/tokens.js';
import Header from './components/Header.jsx';
import MetricBar from './components/MetricBar.jsx';
import PipelineVisualizer from './components/PipelineVisualizer.jsx';
import ManualControls from './components/ManualControls.jsx';
import ScenarioHub from './components/ScenarioHub.jsx';
import TaskList from './components/TaskList.jsx';
import ActivityFeed from './components/ActivityFeed.jsx';

/**
 * Wires the four panels together.
 *
 * The engine is the single source of truth; nothing here holds simulation state
 * beyond which task is selected, so the picture on screen and the state of the
 * experiment can never disagree.
 */
export default function App() {
  const engine = useEngine();
  const [selectedDialogId, setSelectedDialogId] = useState('');

  const running = Boolean(engine.simulation.running);
  const backendMode = ENGINE === 'backend';

  /**
   * The headline connection state. The network channel and the sender are the
   * two things a viewer cares about being "up", so the worst of them wins.
   */
  const status = useMemo(() => {
    const statuses = [engine.nodes.adapterA?.status, engine.nodes.bridge?.status];
    if (statuses.includes('offline')) return 'offline';
    if (statuses.includes('booting')) return 'booting';
    if (statuses.includes('degraded')) return 'degraded';
    return 'online';
  }, [engine.nodes]);

  /**
   * While a demo runs, tint the pipeline with that demo's colour so the diagram
   * and the card being pressed obviously belong together.
   */
  const activeScenario = running ? SCENARIOS.find((item) => item.id === engine.simulation.running) : null;

  const handleRun = useCallback((id) => {
    const scenario = SCENARIOS.find((item) => item.id === id);
    engine.runScenario(id, { protocol: scenario?.protocol ?? 'MCP' });
  }, [engine]);

  const handleReset = useCallback(() => {
    engine.resetEngine();
    setSelectedDialogId('');
  }, [engine]);

  return (
    <div className="relative min-h-screen">
      <Header status={status} running={running} onReset={handleReset} />

      <main className="mx-auto flex max-w-[1600px] flex-col gap-5 px-5 py-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
          {ENGINE === 'backend' ? (
            <>
              <Pill tone={engine.connected ? 'good' : 'bad'} pulse={!engine.connected}>
                {engine.connected ? 'Live backend' : 'Live backend · unreachable'}
              </Pill>
              <span>Every number and event below comes from the backend API.</span>
            </>
          ) : (
            <>
              <Pill tone="warn">Browser simulation</Pill>
              <span>Nothing below is connected to the backend.</span>
            </>
          )}
        </div>

        {engine.banner ? (
          <div
            role="alert"
            className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-[13px] text-slate-100 ${TONE_CLASSES[engine.banner.tone]?.border ?? ''} ${TONE_CLASSES[engine.banner.tone]?.bg ?? ''}`}
          >
            <span className="flex-1">{engine.banner.text}</span>
            <button type="button" className="btn-subtle px-2.5 py-1" onClick={engine.dismissBanner} aria-label="Dismiss this message">
              Dismiss
            </button>
          </div>
        ) : null}

        <MetricBar metrics={engine.metrics} nodes={engine.nodes} />

        <PipelineVisualizer
          wire={engine.wire}
          logs={engine.logs}
          nodes={engine.nodes}
          metrics={engine.metrics}
          dialogs={engine.dialogs}
          dispatch={engine.dispatch}
          clearBlackholes={engine.clearBlackholes}
          backendMode={backendMode}
          manualPanel={backendMode ? (
            <ManualControls
              actions={engine.actions}
              dialogs={engine.dialogs}
              selectedId={selectedDialogId}
              onSelect={setSelectedDialogId}
              busy={engine.busy || running}
              connected={engine.connected}
            />
          ) : null}
          highlightedTone={activeScenario ? { emerald: 'good', amber: 'warn', sky: 'info', violet: 'duplicate', orange: 'warn' }[activeScenario.tone] : null}
        />

        <ScenarioHub
          simulation={engine.simulation}
          scenarioResults={engine.scenarioResults}
          activeScenario={activeScenario?.id ?? null}
          onRun={handleRun}
          onRunAll={engine.runAllScenarios}
        />

        <div className="grid gap-5 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <TaskList dialogs={engine.dialogs} selectedId={selectedDialogId} onSelect={setSelectedDialogId} />
          </div>
          <div className="flex min-h-[520px] flex-col lg:col-span-7">
            <ActivityFeed logs={engine.logs} onClear={engine.clearLogs} />
          </div>
        </div>
      </main>

      <footer className="mt-2 border-t border-white/[0.06] bg-night-950/40">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-1.5 px-5 py-4 text-[11.5px] text-slate-600 lg:px-8">
          <span className="text-slate-500">Nighthawks &middot; AIORI-3 &middot; Track 6G &amp; Future Networks &middot; PS-021</span>
          <span>Built with React, Vite and Tailwind CSS</span>
          <span className="ml-auto">
            Every task reference, packet number and checkpoint is recorded and can be opened in the activity feed.
          </span>
        </div>
      </footer>
    </div>
  );
}
