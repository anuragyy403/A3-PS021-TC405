/**
 * Backend server entry point.
 *
 * 1. Initialises the sql.js WebAssembly engine.
 * 2. Opens the SQLite database (creates the file if it does not exist).
 * 3. Creates the Express application.
 * 4. Starts listening on the configured port.
 * 5. Registers signal handlers for graceful shutdown.
 */

import { config } from './config/index.js';
import { initDb, openDatabase, closeDatabase } from './db/index.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  // 1. Initialise the WebAssembly SQLite engine
  const engine = await initDb();
  logger.info('sql.js engine initialised');

  // 2. Open / create the database
  const { db, dbPath } = openDatabase(config.dbPath, engine);
  logger.info('database opened', { path: dbPath });

  // 3. Create Express application
  const app = createApp(db);

  // 4. Start listening
  const server = app.listen(config.port, () => {
    logger.info('server listening', { port: config.port, env: config.nodeEnv });
  });

  // 5. Graceful shutdown
  function shutdown(signal: string): void {
    logger.info('shutdown requested', { signal });

    server.close(() => {
      logger.info('HTTP server closed');
      closeDatabase(db);
      logger.info('database closed');
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
