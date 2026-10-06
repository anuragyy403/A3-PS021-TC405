/**
 * Express health endpoint tests — Phase 2.3
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { SqlJsStatic } from 'sql.js';

import { initDb, openDatabase, closeDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initDb();
});

describe('GET /health', () => {
  it('returns 200 with status ok when database is open', async () => {
    const { db } = openDatabase(':memory:', SQL);
    const app = createApp(db);

    const res = await (request(app) as ReturnType<typeof request>).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('nighthawks-backend');
    expect(res.body.db).toBe('open');
    expect(res.body.ts).toBeTruthy();

    closeDatabase(db);
  });

  it('returns 404 for unknown routes', async () => {
    const { db } = openDatabase(':memory:', SQL);
    const app = createApp(db);

    const res = await (request(app) as ReturnType<typeof request>).get('/no-such-route');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');

    closeDatabase(db);
  });
});
