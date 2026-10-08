/**
 * Express health endpoint tests — Phase 2.3 (runtime-based since Phase 6b)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import os   from 'node:os';
import path from 'node:path';
import fs   from 'node:fs';

import { createApp } from '../src/app.js';
import { SimulationRuntime } from '../src/runtime/SimulationRuntime.js';

let dir: string;
let runtime: SimulationRuntime;

beforeEach(async () => {
  dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'nighthawks-health-'));
  runtime = await SimulationRuntime.create({
    dbPath: path.join(dir, 'health.db'), maxAttempts: 5, allowReset: true, eventBufferSize: 100,
  });
});

afterEach(() => {
  runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('returns 200 with status ok when database is open', async () => {
    const app = createApp(runtime);

    const res = await (request(app) as ReturnType<typeof request>).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('nighthawks-backend');
    expect(res.body.db).toBe('open');
    expect(res.body.ts).toBeTruthy();
  });

  it('returns 404 for unknown routes', async () => {
    const app = createApp(runtime);

    const res = await (request(app) as ReturnType<typeof request>).get('/no-such-route');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
