/**
 * Minimal structured logger.
 *
 * Writes JSON lines to stdout (easy to pipe to log aggregators) or a
 * human-readable format in development.  Keeps the dependency count low
 * while still being structured enough to grep in a demo.
 */

import { config } from './config/index.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[config.logLevel];
}

function write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry = {
    ts:    new Date().toISOString(),
    level,
    msg,
    ...meta,
  };

  const line = config.nodeEnv === 'test'
    // Suppress all output during tests unless LOG_LEVEL is explicitly set to debug.
    ? (config.logLevel === 'debug' ? JSON.stringify(entry) : null)
    : JSON.stringify(entry);

  if (line !== null) {
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : console.log)(line);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => write('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => write('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
