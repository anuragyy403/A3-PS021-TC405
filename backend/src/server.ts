/**
 * Backend server entry point.
 *
 * 1. Refuses DB_PATH=':memory:' (restart and reset need a real file).
 * 2. Builds the SimulationRuntime: opens the SQLite file (created on first
 *    write), builds both adapters, and recovers dialogs left active by a
 *    previous run.
 * 3. Creates the Express application and starts listening.
 * 4. On SIGINT/SIGTERM: closes the HTTP server, then the runtime.
 */

import { config } from './config/index.js';
import { createApp } from './app.js';
import { logger } from './logger.js';
import { SimulationRuntime } from './runtime/SimulationRuntime.js';

async function main(): Promise<void> {
  // 1. A restart must re-read a FILE; an in-memory database cannot survive it.
  if (config.dbPath === ':memory:') {
    logger.error('refusing to start: DB_PATH=:memory: is not supported by the server '
      + '(restart and reset need a database file)');
    process.exit(1);
  }

  // 2. Runtime (sql.js engine, database file, adapters, recover())
  const runtime = await SimulationRuntime.create({
    dbPath:          config.dbPath,
    maxAttempts:     config.maxAttempts,
    allowReset:      config.allowReset,
    eventBufferSize: config.eventBufferSize,
  });
  const state = runtime.getState();
  logger.info('runtime ready', {
    path:      config.dbPath,
    dialogs:   state.metrics.dialogs_total,
    recovered: runtime.events().events.filter(e => e.type === 'dialog_recovered').length,
  });

  // 3. HTTP
  const app    = createApp(runtime);
  const server = app.listen(config.port, () => {
    logger.info('server listening', { port: config.port, env: config.nodeEnv });
  });

  // 4. Graceful shutdown
  function shutdown(signal: string): void {
    logger.info('shutdown requested', { signal });

    server.close(() => {
      logger.info('HTTP server closed');
      runtime.close();
      logger.info('runtime closed');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('shutdown timeout — forcing exit');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error', err);
  process.exit(1);
});
