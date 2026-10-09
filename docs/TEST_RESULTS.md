# Nighthawks PS-021 — Test Results

Experimental hackathon prototype: two mock agent adapters, an experimental dialog
schema, durable state in a SQLite file. Not a production system, not a final IETF
protocol, not an MCP/A2A implementation, not exactly-once delivery.

Every number below comes from runs executed on **2026-10-09** on the machine described
here. Nothing is estimated.

## 1. Environment

| Item | Version |
|---|---|
| OS | Microsoft Windows 11 Home Single Language 10.0.26200 |
| Node.js / npm | v24.14.1 / 11.11.0 |
| Browser (E2E) | Microsoft Edge 154.0.4258.62 (installed system Edge, Playwright `channel: 'msedge'`; no Playwright browser download) |
| Backend test runner | Vitest 1.6.0, supertest 7.0.0; server run by tsx 4.15.6 |
| Frontend | React 18.3.1, Vite 5.4.21; unit tests: plain Node + jsdom 30.1.1 + esbuild 0.21.5 |
| E2E | @playwright/test 1.63.0 |
| Code under test | branch `phase-3a-recovery`, Phase 8 commit `8b4b1f7` + Phase 9 working tree (E2E package, two `data-testid` attributes; backend unchanged) |

## 2. Commands

```bash
cd backend        && npm test && npm run typecheck
cd Front/frontend && npm test && npm run build && npm run lint
cd e2e            && npm run e2e          # also runs Front/frontend/tests/backend-smoke.mjs against its backend
```

## 3. Results per level

| Level | Suite | What runs | Count | Result |
|---|---|---|---|---|
| Backend unit + integration | `backend/tests/*.test.ts` (Vitest) | adapters, DialogManager, storage, lifecycle, recovery, transport, event log, runtime, queries, five scenarios | 14 files, **265 tests** | **265 passed** |
| — of which HTTP API | `api.test.ts`, `scenariosApi.test.ts`, `health.test.ts` (supertest against the Express app) | every endpoint, validation, error mapping, scenario run/list, manual HTTP scenario sequences | 41 + 19 + 2 = **62 tests** | **62 passed** |
| Backend type check | `npm run typecheck` (`tsc --noEmit`) | whole backend | — | no errors |
| Frontend unit | `Front/frontend` `npm test` | `mappers.mjs` (mappers vs captured real backend responses), `messages.mjs` (user texts), `backendEngine.mjs` (polling hook, ManualControls, whole App in jsdom vs a scripted fake `fetch`) | 33 + 8 + 23 = **64 checks** | **64 passed** |
| Frontend build / lint | `npm run build`, `npm run lint` (oxlint) | production bundle; lint over `src/` | — | build OK; **0 warnings** |
| Client smoke | `Front/frontend/tests/backend-smoke.mjs` (run inside the E2E suite against its backend on :3101) | dashboard API client (`src/api/client.js`) vs a real backend: create/send/retry/complete, typed errors, fail + restart, scenario run + events, NETWORK error | **6 steps** | **6 passed** |
| Browser E2E | `e2e/tests/*.spec.js` (Playwright, Edge headless) | real browser → Vite (:5199) → backend process (:3101) → temp SQLite file | **16 tests** | **16 passed in each of 3 consecutive runs** |

E2E run durations (wrapper `npm run e2e`, wall clock including server start/stop):
**70.8 s, 70.9 s, 71.8 s** — 16/16 passed each time, ports 3101/5199 free afterwards,
no orphaned processes.

Backend per file: `api` 41, `DialogManager` 38, `lifecycle` 30, `adapters` 29,
`runtime` 26, `scenariosApi` 19, `recovery` 18, `storage` 17, `scenarioRunner` 13,
`observedTransport` 11, `scenarios` 8, `eventlog` 8, `queries` 5, `health` 2.

### Browser E2E tests

| Test | Asserts in the UI | Cross-checks over HTTP |
|---|---|---|
| A. smoke | "Live backend", "All connected", "4 of 4 components online", five cards titled exactly as the backend registry, all "Not run yet", empty task list, no simulation UI | `/api/scenarios` titles, `/api/state` nodes online, 0 dialogs |
| B1–B5. each scenario from its card | "Running…", live "Step by step" panel, "Demo running"; then "Passed in …", "Demo N finished: all K checks passed", "1 of 5 passed"; each created task's state label, work count, "Finished after a restart" for S4/S5; key feed lines (lost request / lost reply / retry / duplicate blocked / process restarted / reloaded from the SQLite file) | `last_result` passed, every assertion ok; each dialog's `state`, `restored`, `processed_count`, `task_id`; `/api/state` holds exactly those dialogs |
| C. run all five | "5 of 5 passed", every card passed; Tasks card "6" and "1 not started, 5 finished successfully"; Recovery card "100%" and "2 of 2 recoveries succeeded · 1 restored task still open"; Duplicates card | all five `passed`; `by_state` = 1 INITIATED, 3 COMMITTED, 2 RECOVERED; Scenario 1's D1 is INITIATED **and restored** (reloaded by the later restarts) |
| Da. reply lost → retry → duplicate → complete | exact result lines, "1 of 1 work items", "2 duplicates blocked since server start", "Completed" | `processed_count` 1 and `side_effects_since_boot` 1 throughout, `duplicates_since_boot` 1 → 2, COMMITTED, same ids |
| Db. request lost → retry → complete | "request lost · B never saw it", ledger square "sent, not processed yet" → "processed", COMMITTED | ledger `pending_unprocessed` → `acked`, `processed_count` 0 → 1 |
| Dc. restart mid-task | seq 1–2 processed, seq 3 reply lost, "Restart Adapter A" line, recovered row `… · PROCESSING · next_seq 4 · no answer yet: [3]`, retry + duplicate of seq 3 blocked, "Send seq 4" processed, "task completed after a restart → RECOVERED" | same `dialog_id`/`task_id`, `restored` true, `next_seq` 4 / pending [3] after restart, `side_effects_since_boot` 0 after both retries, 1 after seq 4; one dialog for the task |
| Dd. errors | complete on INITIATED → "Nothing to complete yet…"; complete with seq 1 pending → "Cannot complete yet — seq 1 has no answer. Retry seq 1 first."; finished task: Send/Complete/Abort disabled, Retry enabled and returns "duplicate blocked … task COMMITTED" | 409 `PENDING_REQUESTS` with `details.pending_seqs` [1]; states INITIATED → PROCESSING → COMMITTED |
| De. busy | while Scenario 5 runs: busy hint, all eight manual buttons disabled; enabled again after "Passed" | — (UI-only rule) |
| Df. abort | "task aborted by the operator → FAILED", "Failed", "Stopped before finishing — …", reason in the feed | FAILED, terminal |
| E. offline / recovery | after killing the backend process: "Live backend · unreachable", "Disconnected", paused-controls hint, all manual buttons disabled, tasks still listed; a demo click shows the NETWORK text in the banner; after starting a **new process on the same DB file**: reconnects by itself, tasks listed with their states, "reloaded" feed line; the reloaded task continues with seq 2 and ends RECOVERED | same `db_path_name`, new epoch; open task PROCESSING + `restored`, `next_seq` 2; finished task still COMMITTED |
| F. reset | "Start over" → "No tasks yet", five "Not run yet", no "N of 5 passed", feed shows only "Demo data wiped — starting fresh" | epoch changed, 0 dialogs, no `last_result` |
| backend-smoke | — | the 6-step client smoke script exits 0 against :3101 |

Every E2E test also fails on any page error and on any unexpected browser console
error (expected HTTP errors are whitelisted per test: 409 in Dd, 500 from the proxy while
the backend is down in E).

## 4. Scenario × level matrix

✔ = covered and passing in the runs above. "Run endpoint" = `POST /api/scenarios/:id/run`.

| Scenario | Adapter level (`scenarios.test.ts`) | Scenario runner on the live runtime (`scenarioRunner.test.ts`) | HTTP call sequence (`scenariosApi.test.ts`) | Run endpoint (`scenariosApi.test.ts`) | Browser E2E (`e2e/`) |
|---|---|---|---|---|---|
| 1. Multiple Dialogs + Retry → Correct Correlation | ✔ | ✔ | ✔ | ✔ | ✔ B1, C |
| 2. Request Lost → Retry | ✔ | ✔ | ✔ | ✔ | ✔ B2, C; manual Db |
| 3. Response Lost → Duplicate Request | ✔ (2 tests) | ✔ | ✔ | ✔ | ✔ B3, C; manual Da |
| 4. Adapter B Restart → Durable State Recovery | ✔ | ✔ | ✔ | ✔ | ✔ B4, C; real OS-process restart in E |
| 5. Mid-Task Disconnect + Adapter A Restart → Resume — response lost | ✔ | ✔ | ✔ | ✔ | ✔ B5, C; manual Dc |
| 5. … — request lost variant | ✔ | ✔ | ✔ | ✔ | — (the dashboard card runs the default variant only) |

## 5. What each level proves — and does not

| Level | Proves | Does **not** prove |
|---|---|---|
| Backend unit/integration | Adapter, lifecycle, dedup on `(dialog_id, seq)`, send log and `recover()` behave as specified, including all five scenarios, with the store reopened from the file | Anything about HTTP, the browser or a separate OS process (tests restart the runtime inside one process) |
| HTTP API (supertest) | Every endpoint's contract, validation and error mapping; the scenarios driven purely through HTTP calls | Behaviour over a real network socket or through the Vite proxy; the dashboard |
| Frontend unit | Mapping of real backend responses, user texts, polling/backoff/cursor/epoch logic, one API call per control, enable/disable rules, in jsdom with a fake `fetch` | That the real backend answers that way at runtime; real browser rendering |
| Client smoke | The dashboard's API client against a real running backend process | The UI |
| Browser E2E | The integrated system: real Edge → Vite proxy → backend process → SQLite file; the five scenarios and manual flows as a user sees them, each cross-checked against the backend; durability across a **real OS-process kill and restart** on the same file | Other browsers; concurrency or load; crash *during* a write; interoperability between independently implemented adapters |

## 6. Mutation check (do the E2E tests catch real breakage?)

Each fault was injected temporarily, the full E2E suite was run, and the file was then
restored (sha256 byte-identical; `git diff` on `backend/` and `Front/frontend/src` empty
afterwards apart from the two `data-testid` attributes). Run against the final suite.

| Mutation | Where | E2E result | Caught by |
|---|---|---|---|
| (a) duplicate result line reworded | `Front/frontend/src/api/messages.js` (`outcomeMessage`) | 13 passed, **3 failed** (125.7 s) | Da, Dc, Dd |
| (b) dedup check disabled (`if (existing !== null)` → never true) | `backend/src/adapters/AdapterB.ts` (`handleRequest`) | 6 passed, **10 failed** (498.6 s) | backend-smoke, Da, Dc, Dd, De, F, B3, B4, B5, C |
| (c) no reconnect after a network failure (poll loop stops) | `Front/frontend/src/api/useBackendEngine.js` | 15 passed, **1 failed** (95.4 s) | E (never reconnects) |

Finding from (b): with the dedup check disabled, the backend's insert-conflict fallback
still answers `duplicate` and `processed_count` stays 1, so the UI still reads "duplicate
blocked" — only `side_effects_since_boot` shows the work ran twice. The manual E2E tests
therefore assert `side_effects_since_boot`, which is what makes Da and Dc catch it.

## 7. Known limitations (unchanged by testing)

- **Crash window.** Adapter B runs the side effect *before* the processed record is
  persisted. A crash between the two means a retry runs the work again: the guarantee is
  duplicate-side-effect prevention **once the original request has been durably
  recorded**, not exactly-once.
- **Single process, shared store.** Both adapters live in one Node.js process over one
  SQLite file; "Restart Adapter A" and "Restart Adapter B" are both a full process-level
  rebuild from that file. The E2E offline test additionally kills and restarts the real
  OS process.
- **In-memory counters.** `duplicates_since_boot` and `side_effects_since_boot` are in
  memory and reset on every restart; the dashboard labels per-task duplicates "since
  server start".
- **Events in memory.** The activity event log is held in memory and lost when the
  process exits (a new process starts a new epoch).
- **Non-atomic persistence.** The SQLite file is rewritten in place after each change; a
  crash during that write could corrupt it (not tested).
- **No concurrency.** The runtime serialises mutations with one lock (`409 RUNTIME_BUSY`);
  concurrent duplicate requests and multi-node operation are out of scope.

## 8. Interoperability — not claimed

The Problem Statement lists "interoperability and recovery test results". These results
cover **recovery** only. Both adapters are written by the same team, in one codebase,
against one schema; **no interoperability between independently implemented adapters,
and none with MCP or A2A, is claimed or tested.** What the mentors expect under
"interoperability" is an open question to clarify.
