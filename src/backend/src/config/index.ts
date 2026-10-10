/**
 * Centralised configuration.
 *
 * All tuneable values live here so the rest of the application has a single
 * import rather than scattered process.env reads.
 */

import path from 'node:path';

const env = process.env;

export const config = {
  /**
   * HTTP port for the Express server.
   * Default: 3001  (Vite dev server occupies 5173, keep clear)
   */
  port: Number(env['PORT'] ?? 3001),

  /**
   * Absolute path to the SQLite database file.
   *
   * Tests override this via DB_PATH to use an isolated temp file so parallel
   * or sequential test runs never share state.
   *
   * Default: <repo>/backend/dialogs.db
   */
  dbPath: env['DB_PATH'] ?? path.resolve(process.cwd(), 'dialogs.db'),

  /**
   * Node environment.
   */
  nodeEnv: env['NODE_ENV'] ?? 'development',

  /**
   * Minimum log level written to stdout.
   * 'debug' | 'info' | 'warn' | 'error'
   */
  logLevel: (env['LOG_LEVEL'] ?? 'info') as 'debug' | 'info' | 'warn' | 'error',

  /**
   * Adapter A retry budget: unanswered attempts of one PENDING request before
   * its dialog is moved to FAILED.  Validated by AdapterA (positive integer).
   * Default: 5 (= DEFAULT_MAX_ATTEMPTS)
   */
  maxAttempts: Number(env['MAX_ATTEMPTS'] ?? 5),

  /**
   * Whether the demo-only reset (wipe the database file) is allowed.
   * ALLOW_RESET=false|0 disables it, any other value enables it.
   * Default: on, unless NODE_ENV=production.
   */
  allowReset: env['ALLOW_RESET'] !== undefined
    ? !['false', '0'].includes(env['ALLOW_RESET'].toLowerCase())
    : (env['NODE_ENV'] ?? 'development') !== 'production',

  /**
   * Capacity of the in-memory activity event buffer (oldest evicted first).
   * Validated by EventLog (positive integer).
   * Default: 1000
   */
  eventBufferSize: Number(env['EVENT_BUFFER_SIZE'] ?? 1000),
} as const;
