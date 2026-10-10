/**
 * Database connection factory and schema initialisation.
 *
 * Driver: sql.js (pure WebAssembly SQLite)
 *
 * DRIVER NOTE:
 *   sql.js is the driver in use.  It embeds the SQLite engine as WebAssembly,
 *   needs no native compilation, and runs standard SQLite SQL.  A native
 *   driver (better-sqlite3) was not used because it needs a C++ build
 *   toolchain that is not available on the development machine.
 *
 *   Persistence model: sql.js keeps the database in memory.  After every
 *   mutation the whole database is exported and written to the .db file by
 *   `persistToDisk(db, dbPath)` (fs.writeFileSync — an in-place overwrite,
 *   not an atomic rename).  On startup the file is read back into memory.
 *   This file is the only place that knows about the driver.
 *
 * Usage:
 *
 *   import { openDatabase, persistToDisk, closeDatabase } from './db';
 *
 *   const { db, dbPath } = openDatabase('/abs/path/to/dialogs.db');
 *   // ... mutate via repositories ...
 *   persistToDisk(db, dbPath);    // ← flush to disk after each write
 *   closeDatabase(db);
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import fs   from 'node:fs';
import path from 'node:path';

export type { Database };

/** sql.js engine singleton — initialised once on first openDatabase() call. */
let SQL: SqlJsStatic | null = null;

async function getSqlEngine(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

/** Raw SQL for the schema, read once at module load. */
// __dirname is available in CJS (compiled output) and also in tsx via
// its CJS compatibility shim. We use it directly.
const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, 'schema.sql'),
  'utf8',
);

/**
 * Result of openDatabase — bundles the in-memory Database with the file path
 * so callers can hand both to persistToDisk without extra bookkeeping.
 */
export interface DbHandle {
  db:     Database;
  dbPath: string;
}

/**
 * Open (or create) a SQLite database at `dbPath`.
 *
 * - If the file exists, it is read into memory (sql.js works in-memory).
 * - If the file does not exist, a fresh database is created.
 * - The schema is applied idempotently (CREATE TABLE IF NOT EXISTS).
 *
 * This function is synchronous from the caller's perspective because it uses
 * the pre-initialised engine.  Call `await initDb(path)` once at startup
 * to ensure the engine is loaded.
 *
 * @param dbPath  Absolute path to the .db file, or ':memory:' for tests.
 */
export function openDatabase(dbPath: string, engine: SqlJsStatic): DbHandle {
  let db: Database;

  if (dbPath === ':memory:' || !fs.existsSync(dbPath)) {
    // Fresh in-memory database
    db = new engine.Database();
  } else {
    // Load existing file into memory
    const fileBuffer = fs.readFileSync(dbPath);
    db = new engine.Database(fileBuffer);
  }

  // Apply schema (idempotent)
  db.run(SCHEMA_SQL);

  return { db, dbPath };
}

/**
 * Flush the in-memory sql.js database to disk.
 *
 * Call this after every mutation (DialogRepository.create,
 * DialogRepository.updateState, RequestRepository.record).
 *
 * No-op when dbPath is ':memory:' (test isolation mode).
 */
export function persistToDisk(db: Database, dbPath: string): void {
  if (dbPath === ':memory:') return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

/**
 * Initialise the sql.js WebAssembly engine.
 *
 * Must be called once at application startup before any database operations.
 * Subsequent calls are no-ops (engine is cached).
 */
export async function initDb(): Promise<SqlJsStatic> {
  return getSqlEngine();
}

/**
 * Close the database (free the wasm memory).
 *
 * In sql.js, `db.close()` frees the wasm-allocated memory.
 * It does NOT write to disk — call persistToDisk first if you have pending
 * mutations.
 */
export function closeDatabase(db: Database): void {
  db.close();
}
