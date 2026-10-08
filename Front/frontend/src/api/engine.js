import { useCorrelationEngine } from '../lib/useCorrelationEngine.js';
import { useBackendEngine } from './useBackendEngine.js';

/**
 * Which engine drives the dashboard, chosen once at module load so hooks are
 * never called conditionally:
 *
 *   VITE_ENGINE=backend (default under Vite) → useBackendEngine: the backend API
 *                                              is the source of truth
 *   VITE_ENGINE=sim                         → useCorrelationEngine: the original
 *                                              in-browser simulation
 *
 * Outside a Vite build (import.meta.env undefined — e.g. the Node conformance
 * harness, which has no dev proxy and no backend) it falls back to the simulation.
 */
export function selectEngine(viteEnv) {
  if (!viteEnv) return 'sim';
  return viteEnv.VITE_ENGINE === 'sim' ? 'sim' : 'backend';
}

export const ENGINE = selectEngine(import.meta.env);

export const useEngine = ENGINE === 'backend' ? useBackendEngine : useCorrelationEngine;
