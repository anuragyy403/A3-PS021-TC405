# Nighthawks E2E tests (PS-021)

Browser end-to-end tests of the integrated prototype: a real browser (the locally
installed **Microsoft Edge**, driven by Playwright) → the Vite dev server → the real
backend → a SQLite file. Results of the latest runs: [`docs/TEST_RESULTS.md`](../docs/TEST_RESULTS.md).

This is a separate package so the dashboard's dependencies stay unchanged.

## Prerequisites

- Node.js 20+ (verified with v24.14.1) and npm
- Microsoft Edge installed (Playwright uses it via `channel: 'msedge'`; **no Playwright
  browser download** is needed — do not run `npx playwright install`)
- Dependencies installed in `backend/` and `Front/frontend/` (`npm install` in each)

## Install and run

```bash
cd e2e
npm install
npm run e2e          # headless, ~1–2 min
npm run e2e:headed   # same, with a visible Edge window
```

Demo backup assets (not part of `npm run e2e`; same isolated ports 3101/5199):

```bash
npm run demo:record        # video of the talk track (steps 1–6, 8) → e2e/demo-output/*.webm (gitignored)
npm run demo:screenshots   # PNGs → docs/assets/screenshots/ (committed) + the offline-fonts check
```

`demo:record` needs Playwright's ffmpeg once: `npx playwright install ffmpeg` (1.4 MB; no browser).

Submission documents (offline; every request during the build must be local):

```bash
npm run report:diagrams    # docs/assets/diagrams/*.svg — verified against backend/src first
npm run report:pdf         # diagrams + docs/submission/Nighthawks-PS-021-Report.pdf and -Deck.pdf
```

Extra Playwright arguments pass through, e.g. `npm run e2e -- tests/manual.spec.js`
or `npm run e2e -- -g "scenario 4"`. Set `E2E_TRACE=on` to keep a trace for every test
(default: only for failures, in `test-results/artifacts/`).

## What the run starts (and stops)

| Process | Port | Started by | Notes |
|---|---|---|---|
| Backend (`node --import tsx src/server.ts`, one process, no watch) | **3101** | `support/fixtures.js` (worker fixture) | `DB_PATH` = a fresh temp file `%TEMP%/nighthawks-e2e-*.db` (never `backend/dialogs.db`); deleted at the end; log in `test-results/backend-*.log` |
| Vite dev server | **5199** | Playwright `webServer` | `VITE_BACKEND_URL=http://localhost:3101`, so `/api` and `/health` are proxied there |

These ports never clash with the normal dev servers (3001 / 5173).

- One worker; every test resets the backend (`POST /api/reset`) and reloads the
  dashboard before it starts.
- The offline test stops the backend with a hard kill and starts a new process on
  the **same** database file.
- Google Fonts requests are answered locally with an empty stylesheet, so the run
  does not depend on internet access (that request was the only external one, and
  it intermittently held `page.goto` for ~9 s).
- `scripts/run-e2e.mjs` refuses to start if 3101 or 5199 is taken, and afterwards
  checks that both ports are free and that no node/esbuild process started by the
  run (backend, Vite, esbuild) is still alive. Orphans are listed, killed, and the
  run exits non-zero.

## Specs (`tests/`)

| File | Covers |
|---|---|
| `smoke.spec.js` | A — app loads, live backend, 4/4 online, five cards titled exactly as the backend registry |
| `scenarios.spec.js` | B1–B5 — each scenario from its card; C — "Run all five" and the Tasks/Recovery card numbers |
| `manual.spec.js` | Da–Df — manual flows by clicking the controls (reply lost, request lost, restart, errors, busy, abort) |
| `offline.spec.js` | E — backend process killed and restarted on the same DB |
| `reset.spec.js` | F — header "Start over" |
| `backend-smoke.spec.js` | runs `Front/frontend/tests/backend-smoke.mjs` against the E2E backend |

Every test checks the UI **and** cross-checks the backend over HTTP, and fails on
page errors or unexpected console errors.

## Troubleshooting

- **"port 3101 (or 5199) is already in use"** — something else listens there.
  Find it with `netstat -ano | findstr :3101` and stop it if it is yours.
- **Orphaned `tsx` / `vite` / `esbuild` processes after an aborted run (Windows).**
  List them:
  ```powershell
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'nighthawks-e2e|vite\\bin\\vite.js' } | Select-Object ProcessId,CommandLine
  ```
  and stop one with `taskkill /PID <pid> /T /F`.
- **Edge not found** — Playwright looks for the stable channel under
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.
- **`[WebServer] http proxy error … ECONNREFUSED`** lines during the offline test are
  expected: the backend is down on purpose.
