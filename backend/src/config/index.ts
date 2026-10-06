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
} as const;
