# Backend HTTP API — Design (Phase 5)

> **Status: implemented in Phase 6** (6a runtime, 6b routes, 6c scenarios). The design below is kept as written in Phase 5. Where the implementation differs, the [Implementation status](#implementation-status-phase-6) section says so, and the code wins. Frontend wiring is Phases 7–8.

> **Non-claims.** This API drives two *mock* adapters in one process. It is **not** an MCP or A2A implementation, **not** an IETF standard or draft implementation, and it does **not** provide exactly-once delivery. The guarantee it exposes is the one the backend has: duplicate-side-effect prevention when the original request has already been durably recorded as processed.

**Goal.** Expose the minimum the existing frontend needs so that, from Phase 7 on, the backend is the source of truth for dialog/task/seq identity, correlation, deduplication, lifecycle, durable state, recovery, side effects and failure simulation. The frontend keeps visualization and controls.

**Inputs read for this design:** `backend/src/{app,server}.ts`, `config/index.ts`, `errors.ts`, `types/index.ts`, `adapters/*.ts`, `services/DialogManager.ts`, `repositories/*.ts`, `db/index.ts`, `tests/scenarios.test.ts`, `tests/lifecycle.test.ts`, `docs/EXPERIMENTAL_SCHEMA.md`; `Front/frontend/src/App.jsx`, `lib/useCorrelationEngine.js`, `lib/constants.js`, `lib/narrate.js`, `components/*.jsx`, `tests/conformance.mjs`.

---

## Implementation status (Phase 6)

**All endpoints E1–E14 are implemented.** They live in `backend/src/app.ts`, `backend/src/http/` and `backend/src/runtime/`; the scenario scripts are in `backend/src/scenarios/`.

| Test file | Covers |
|---|---|
| `tests/api.test.ts` | E1–E10, E13, E14, the error mapping, §15.1, §15.2 |
| `tests/scenariosApi.test.ts` | E11, E12, the five scenarios as manual HTTP sequences, 413 |
| `tests/scenarioRunner.test.ts` | The scenario runner |
| `tests/runtime.test.ts`, `observedTransport.test.ts`, `eventlog.test.ts`, `queries.test.ts` | The runtime layer |

### Deviations from the design below

| # | Area | Implemented behaviour | Why |
|---|---|---|---|
| 1 | E2 `runtime` block | Extra field `uptime_ms` | Convenience; the UI shows uptime |
| 2 | Request bodies | **Every** body rejects unknown keys with `400` (not only E7). E8 and E10 accept no keys at all | A typo such as `faults` must not be silently ignored |
| 3 | `request_sent` / `retry_sent` | Emitted by the runtime just **before** the Adapter A call, with the seq predicted as `MAX(seq)+1` under the lock (exact, because the lock is held) | Keeps event order correct: sent, then B's events. Adapter A still writes the `PENDING` row before the transport call |
| 4 | Event ids | Keep increasing across reset (`clear()`). `truncated` is `true` for a cursor from before a reset | Clients switch on `epoch`; ids never repeat |
| 5 | Reset | Also refreshes `booted_at` and sets `restart_count` back to 0; clears last scenario results | A reset is a fresh demo |
| 6 | Reset of a non-`.db` path | Refused with `403 RESET_DISABLED` (explanatory message) rather than a new code | Same outcome for the client: reset not allowed |
| 7 | Dialog ordering | "Newest first" uses reverse `dialog_id` order (ids are `dlg-<Date.now()>-…`); there is no timestamp column | No schema change. A scenario's `dialogs[]` is ordered by `task_id` (T1, T2) for determinism |
| 8 | Startup | `create()` emits only `dialog_recovered` events, not `adapter_restarted` | Nothing was restarted |
| 9 | `TASK_MISMATCH` | Not reachable through any route: Adapter B reports it inside a `200` response (`error_code`). The `TaskMismatchError`-before-`ConflictError` order is proven by a unit test of `toApiError` | Adapter A never receives it as an exception |
| 10 | Oversized body | `413 PAYLOAD_TOO_LARGE` (body-parser `entity.too.large`, 100 kB default) | Client error, not 500 |
| 11 | Malformed JSON | `400 VALIDATION_ERROR`, message `Malformed JSON body`, no `details` | — |
| 12 | Server start | `DB_PATH=:memory:` is refused (exit code 1) | Restart and reset need a file |
| 13 | E12 ids | Any id that is not 1–5, **including non-numeric** (`abc`, `1.5`), returns `404 SCENARIO_NOT_FOUND` | The resource does not exist |
| 14 | E12 body | `variant` is accepted only for scenario 5; otherwise `400` | §8 defines variants for scenario 5 only |
| 15 | Scenario runs | One run holds the runtime lock for its whole duration, using the unlocked ops (`withLock(ops => …)`), including restarts in Scenarios 4–5 | No manual action can interleave; GETs keep working |
| 16 | Scenario failure | A throwing script returns `200` with `status: "failed"` and `error`; the lock and `running_scenario` are always released; `scenario_finished` is always emitted | The run itself was handled |
| 17 | `passed` | Requires at least one check, all checks ok, and no exception | An empty script is not a pass |
| 18 | `last_result` | Kept in memory per scenario. Survives simulated restarts, cleared by reset, lost when the process exits | No durable store (decided) |
| 19 | `/health` | Reports via `runtime.isOpen()`; `503` once the runtime is closed | Routes only talk to the runtime |
| 20 | Route modules | `http/routes/{runtime,dialogs,scenarios}.ts`, plus `validation.ts` and `errorMiddleware.ts` | Small and flat |

## Contents

1. [Runtime host](#1-runtime-host)
2. [Endpoints](#2-endpoints)
3. [Fault injection](#3-fault-injection)
4. [Send / retry outcome model](#4-send--retry-outcome-model)
5. [HTTP error mapping](#5-http-error-mapping)
6. [Events](#6-events)
7. [Side-effect and counter semantics](#7-side-effect-and-counter-semantics)
8. [Scenarios](#8-scenarios)
9. [Concurrency](#9-concurrency)
10. [Reset and configuration](#10-reset-and-configuration)
11. [Frontend → backend mapping](#11-frontend--backend-mapping)
12. [Dev wiring](#12-dev-wiring)
13. [Build prerequisite](#13-build-prerequisite)
14. [Out of scope](#14-out-of-scope)
15. [End-to-end examples](#15-end-to-end-examples)
16. [Phase 6 implementation checklist](#16-phase-6-implementation-checklist)
17. [Open issues](#17-open-issues)

---

## 1. Runtime host

**Recommendation:** add one object, `SimulationRuntime` (`backend/src/runtime/SimulationRuntime.ts`, Phase 6). It owns everything the tests' `boot()` helper builds today, and the Express app talks only to it.

| Owned by the runtime | Lifetime |
|---|---|
| `DbHandle` (`openDatabase(config.dbPath, engine)`) | Replaced on every restart |
| `Transport` (an observing subclass, §6.4) | Replaced on every restart |
| `InMemorySideEffectTracker` | Replaced on every restart |
| `AdapterA` (`{ maxAttempts: config.maxAttempts }`) | Replaced on every restart |
| `AdapterB` | Replaced on every restart |
| Event ring buffer, counters "since boot", scenario results, mutation lock | Survive simulated restarts; lost when the Node process exits |
| `booted_at`, `restart_count`, `epoch` | `booted_at` updated per restart; `epoch` changes only on reset |

On startup the runtime calls `openDatabase`, builds the adapters, and runs `AdapterA.recover()`, so that dialogs left active by a previous server run are driven again. This uses the same code path as a simulated restart.

### `restart(adapter: 'A' | 'B')`

Both adapters share one sql.js handle. Closing that handle invalidates every repository built on it, including the ones inside the other adapter. A B-only restart that actually re-reads the file is therefore impossible without separate handles, which is out of scope. **Both targets perform the same full restart**, identical to `shutdown()` + `boot()` in `tests/scenarios.test.ts` plus `recover()`:

1. `transport.unregisterRequestHandler()`, then `closeDatabase(db)`.
2. Discard `AdapterA`, `AdapterB`, `Transport` and the side-effect tracker.
3. `openDatabase(dbPath)` reads the SQLite **file** back into memory.
4. Build a fresh transport, tracker, `AdapterB` and `AdapterA`.
5. `AdapterA.recover()`: every `INITIATED`/`PROCESSING` dialog gets `restored = true`, `nextSeq = MAX(seq)+1`, and its `pendingSeqs`.

| Lost | Kept (in the file) |
|---|---|
| Adapter A's set of driven dialogs (rebuilt by `recover()`) | `dialogs` (identity, state, `restored`) |
| Transport drop flags | `requests` (B's processed ledger, stored results) |
| Side-effect counter (`side_effects_since_boot` restarts at 0) | `outbound_requests` (A's send log: payload, `PENDING`/`ACKED`, attempts) |
| Counters "since boot" that are not derived from tables (§7) | |

**What `adapter` changes:** only the narration and the response. The `adapter_restarted` event records `target: "A"|"B"` and **always** `scope: "process"` with the note *"shared store: both adapter objects rebuilt from the SQLite file"*. The demo must not claim B restarted while A kept running.

**Consequence (intended, matches Scenarios 4 and 5):** any restart marks *every* active dialog `restored`, so each of them will later complete as `RECOVERED`, not `COMMITTED`. See [Open issue 1](#17-open-issues).

---

## 2. Endpoints

All bodies are JSON. Schemas are zod-style (`z` from `zod`, already a dependency). Identifier formats: `DialogId = z.string().min(1).max(128)`, `TaskId = z.string().min(1).max(128)`, `Seq = z.coerce.number().int().positive()`.

| # | Method | Path | Purpose | Mutates |
|---|---|---|---|---|
| E1 | GET | `/health` | Liveness (exists today) | — |
| E2 | GET | `/api/state` | Snapshot: dialog summaries, metrics, nodes, runtime info | — |
| E3 | GET | `/api/dialogs` | Dialog summaries | — |
| E4 | GET | `/api/dialogs/:dialogId` | One dialog with processed requests and send log | — |
| E5 | POST | `/api/dialogs` | Start a dialog for a `task_id` | ✔ |
| E6 | POST | `/api/dialogs/:dialogId/requests` | Send the next request (optional fault) | ✔ |
| E7 | POST | `/api/dialogs/:dialogId/requests/:seq/retry` | Retry an existing seq (optional fault) | ✔ |
| E8 | POST | `/api/dialogs/:dialogId/complete` | Complete → `COMMITTED` / `RECOVERED` | ✔ |
| E9 | POST | `/api/dialogs/:dialogId/fail` | Abort → `FAILED` | ✔ |
| E10 | POST | `/api/adapters/:adapter/restart` | Full restart + `recover()` | ✔ |
| E11 | GET | `/api/scenarios` | The five scenarios + last result of each | — |
| E12 | POST | `/api/scenarios/:id/run` | Run a scenario on the live runtime | ✔ |
| E13 | GET | `/api/events` | Events after a cursor | — |
| E14 | POST | `/api/reset` | Demo-only: wipe the database and runtime | ✔ |

Every mutating endpoint takes the runtime lock (§9). Busy → `409 RUNTIME_BUSY`.

### Shared response types

```ts
type LifecycleState = 'INITIATED' | 'PROCESSING' | 'COMMITTED' | 'RECOVERED' | 'FAILED';

interface DialogSummary {
  dialog_id: string;
  task_id: string;
  state: LifecycleState;
  restored: boolean;
  terminal: boolean;                 // isTerminal(state)
  next_seq: number;                  // OutboundRequestRepository.maxSeq + 1
  processed_count: number;           // durable: rows in `requests` for the dialog
  pending_seqs: number[];            // durable: PENDING rows in `outbound_requests`
  side_effects_since_boot: number;   // InMemorySideEffectTracker.getProcessCount (resets on restart)
  duplicates_since_boot: number;     // runtime counter (§7)
}

interface SendLogEntry {             // = OutboundRequestRecord, payload parsed
  seq: number;
  payload: unknown;
  status: 'PENDING' | 'ACKED';
  attempts: number;
}

interface ProcessedEntry {           // = RequestRecord, result parsed
  seq: number;
  processed_at: string;              // ISO 8601
  result: unknown;
}

interface ApiError {                 // existing ApiError in types/index.ts, plus optional details
  error: string;                     // machine code, §5
  message: string;
  status: number;
  details?: unknown;                 // zod issues, pending seqs, …
}
```

### E1 `GET /health`
Unchanged (`app.ts`). Frontend need: connection indicator.

### E2 `GET /api/state`

Response `200`:
```ts
{
  runtime: { booted_at: string; restart_count: number; epoch: string;
             db_path_name: string;            // basename only, never the full path
             max_attempts: number; busy: boolean; running_scenario: number | null;
             cursor: number };                // latest event id
  nodes: { adapterA: NodeStatus; adapterB: NodeStatus; transport: NodeStatus; storage: NodeStatus };
  metrics: Metrics;                           // §7
  dialogs: DialogSummary[];                   // newest first
}
type NodeStatus = { status: 'online' | 'restarting' };
```
Calls: `DialogManager.getAllDialogs()`, `OutboundRequestRepository.maxSeq/findPending`, `RequestRepository.countPerDialog()`, `DialogRepository.countByState()`, tracker, runtime counters.
Frontend need: `dialogs`, `metrics`, `nodes` (MetricBar, PipelineVisualizer, TaskList, Header status).

### E3 `GET /api/dialogs`
Query: `state?: LifecycleState`, `limit?: 1..500` (default 200). Response `200`: `{ dialogs: DialogSummary[] }`. Same calls as E2. Frontend need: TaskList refresh without the whole snapshot.

### E4 `GET /api/dialogs/:dialogId`
Response `200`:
```ts
{ dialog: DialogSummary; processed: ProcessedEntry[]; send_log: SendLogEntry[];
  ledger: { seq: number;
            status: 'acked' | 'processed_unacked' | 'pending_unprocessed';
            attempts: number }[] }
```
`ledger` joins the two tables per seq:
- `acked`: the send-log row is `ACKED`.
- `processed_unacked`: the row is `PENDING` but B has processed it (its response was lost).
- `pending_unprocessed`: the row is `PENDING` and B never processed it (the request was lost, or it was refused).

Errors: `404 DIALOG_NOT_FOUND`.
Calls: `DialogManager.getDialog`, `RequestRepository.findByDialog`, **new** `OutboundRequestRepository.findByDialog` (read-only, Phase 6).
Frontend need: TaskList `PacketStrip` (`ledger`), detail view.

### E5 `POST /api/dialogs`
Body: `z.object({ task_id: TaskId })`.
Response `201`: `{ dialog: DialogSummary }` with state `INITIATED`.
Calls: `AdapterA.startDialog(task_id)`. Errors: `400 VALIDATION_ERROR`, `409 RUNTIME_BUSY`.
Frontend need: manual "Send packets" (starts the task), scenario cards (indirectly).

### E6 `POST /api/dialogs/:dialogId/requests`
Body: `z.object({ payload: z.unknown().default(null), fault: Fault.optional() })`, where `Fault = z.enum(['drop_request', 'drop_response'])`.
Response `200`: `SendResult` (§4). Errors: `404 DIALOG_NOT_FOUND`, `409 DIALOG_TERMINAL`, `400`, `409 RUNTIME_BUSY`.
Calls: `Transport.dropNextRequestMessage()` / `dropNextResponseMessage()` when `fault` is set, then `AdapterA.sendRequest(dialogId, payload)`.
Frontend need: `dispatch`, manual send.

### E7 `POST /api/dialogs/:dialogId/requests/:seq/retry`
Body: `z.object({ fault: Fault.optional() })`. The payload is never accepted: a retry always replays the stored payload.
Response `200`: `SendResult`. Errors: `404 DIALOG_NOT_FOUND`, `404 REQUEST_NOT_FOUND` (seq not in the send log), `400`, `409 RUNTIME_BUSY`.
Allowed on terminal dialogs (idempotent replay, state unchanged).
Calls: `AdapterA.retryRequest(dialogId, seq)`.
Frontend need: "Send a duplicate" toggle, retrying a lost request, all scenarios.

### E8 `POST /api/dialogs/:dialogId/complete`
Body: none / `{}`. Response `200`: `{ dialog: DialogSummary }` (state `COMMITTED` or `RECOVERED`).
Errors: `404 DIALOG_NOT_FOUND`; `409 PENDING_REQUESTS` (`details.pending_seqs`); `409 INVALID_TRANSITION` (e.g. from `INITIATED`); `409 DIALOG_TERMINAL` (runtime pre-check, see Open issue 2).
Calls: `AdapterA.completeDialog(dialogId)`.
Frontend need: task completion (manual flow; the frontend simulation settles dialogs by timer today).

### E9 `POST /api/dialogs/:dialogId/fail`
Body: `z.object({ reason: z.string().min(1).max(200) })`. Response `200`: `{ dialog: DialogSummary }`.
Errors: `404`, `409 DIALOG_TERMINAL` (runtime pre-check), `400`, `409 RUNTIME_BUSY`.
Calls: `AdapterA.failDialog(dialogId, reason)`. The reason goes into the `state_transition` event and the logger; it is not persisted.
Frontend need: optional abort control (none today; cheap to add).

### E10 `POST /api/adapters/:adapter/restart`
Params: `adapter = z.enum(['A', 'B'])`. Body: none.
Response `200`:
```ts
{ target: 'A' | 'B'; scope: 'process';
  note: 'shared store: both adapter objects rebuilt from the SQLite file';
  recovered: { dialog_id: string; task_id: string; state: LifecycleState;
               next_seq: number; pending_seqs: number[] }[] }   // = AdapterA.recover() output
```
Errors: `400` (bad adapter), `409 RUNTIME_BUSY`.
Calls: `SimulationRuntime.restart(adapter)` (§1).
Frontend need: crash/restart buttons (the simulation's `killAdapter`/`coldStartAdapter`), Scenarios 4–5.

### E11 `GET /api/scenarios`
Response `200`:
```ts
{ scenarios: { id: 1|2|3|4|5; title: string; last_result: ScenarioResult | null }[];
  running: number | null }
```
Titles are exactly the `describe` names in `tests/scenarios.test.ts`. Frontend need: `scenarioResults`, card badges.

### E12 `POST /api/scenarios/:id/run`
Params `id = z.coerce.number().int().min(1).max(5)`. Body: `z.object({ step_delay_ms: z.number().int().min(0).max(1000).default(0) })`.
Response `200`: `ScenarioResult` (§8). The response is sent **after** the run finishes. Errors: `404 SCENARIO_NOT_FOUND`, `409 RUNTIME_BUSY` (another scenario or any mutation in progress).
Frontend need: `runScenario`; `runAllScenarios` becomes five sequential calls in the UI.

### E13 `GET /api/events`
Query: `since?: number` (default 0, exclusive), `limit?: 1..500` (default 200).
Response `200`:
```ts
{ epoch: string; events: ApiEvent[]; cursor: number;      // id of last returned event (or `since`)
  oldest_available: number; truncated: boolean }           // truncated = events between since and oldest were evicted
```
Frontend need: `logs` (ActivityFeed, narration headline) and `wire` (pipeline animation).

### E14 `POST /api/reset`
Body: `z.object({ confirm: z.literal('RESET') })`. Response `200`: `{ epoch: string }` (new epoch). Errors: `403 RESET_DISABLED`, `400`, `409 RUNTIME_BUSY`. Semantics: §10.
Frontend need: Header "reset" (`resetEngine`).

**Deliberately not exposed:** raw injection of hand-built `AdapterRequest`s to Adapter B; `maxAttempts` changes at runtime; direct table access; the full DB path; stack traces.

---

## 3. Fault injection

**Recommendation: a per-call `fault` field** on E6 and E7 (`"drop_request" | "drop_response"`), not a global transport toggle.

- It maps 1:1 to the existing `Transport.dropNextRequestMessage()` / `dropNextResponseMessage()`, set immediately before the adapter call inside the lock. Nothing else can consume the flag in between.
- There is no leftover global state: after the call the runtime calls `transport.clearFailureFlags()` regardless of the outcome.
- It is deterministic and trivial to test with supertest; scenario scripts use the same call.
- The frontend's "Lose one in the network" becomes `fault: "drop_request"` on that seq.

---

## 4. Send / retry outcome model

A simulated drop is **not** an HTTP error. E6 and E7 return `200` whenever the runtime handled the call, with an explicit outcome:

```ts
interface SendResult {
  dialog_id: string;
  task_id: string;
  seq: number;
  kind: 'send' | 'retry';
  delivery: 'delivered' | 'request_dropped' | 'response_dropped';
  outcome: 'ok' | 'duplicate' | 'rejected' | 'no_answer';
  response: AdapterResponse | null;   // what Adapter A received; null when delivery !== 'delivered'
  error_code?: 'DIALOG_NOT_FOUND' | 'TASK_MISMATCH' | 'DIALOG_TERMINAL' | 'INTERNAL';  // when outcome = rejected
  send_log: SendLogEntry;             // the row after the call (status, attempts)
  dialog: DialogSummary;              // after the call
  dialog_failed: boolean;             // true if this call exhausted the retry budget (dialog now FAILED)
  events: { from: number; to: number };  // event id range produced by this call
}
```

| Transport result | `delivery` | `outcome` | `response` | Send-log row | Notes |
|---|---|---|---|---|---|
| B answered `status: 'ok'` | `delivered` | `ok` | AdapterResponse | `ACKED` | side effect ran once |
| B answered `status: 'duplicate'` | `delivered` | `duplicate` | AdapterResponse (stored result) | `ACKED` | side effect not run |
| B answered `status: 'error'` | `delivered` | `rejected` | AdapterResponse (`error`, `error_code`) | stays `PENDING` | `error_code` copied to the top level |
| `MessageDroppedError` on the request | `request_dropped` | `no_answer` | `null` | stays `PENDING` | B never saw it |
| `MessageDroppedError` on the response | `response_dropped` | `no_answer` | `null` | stays `PENDING` | B *did* run it; the body is A's view, while the events show B's side (§6) |
| Drop with `attempts >= maxAttempts` on a `PENDING` row | as above | `no_answer` | `null` | `PENDING` | `dialog_failed: true`, `dialog.state = FAILED` |

The runtime knows which drop happened because it set the fault itself. A typed property on `MessageDroppedError` would be cleaner (Open issue 3).

Errors that Adapter A **throws before sending** are HTTP errors (§5): `DialogTerminalError` from `sendRequest` → `409`; `NotFoundError` from `retryRequest` for an unknown seq → `404 REQUEST_NOT_FOUND`.

---

## 5. HTTP error mapping

One JSON shape everywhere: the existing `ApiError` (`{ error, message, status }`, `types/index.ts`) with an optional `details`. `app.ts` already renders `AppError` this way; Phase 6 extends the middleware.

| Source | HTTP | `error` |
|---|---|---|
| zod parse failure (body/params/query) | 400 | `VALIDATION_ERROR` (`details` = zod issues) |
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `NotFoundError` — dialog | 404 | `DIALOG_NOT_FOUND` |
| `NotFoundError` — outbound request (retry of unknown seq) | 404 | `REQUEST_NOT_FOUND` |
| Unknown scenario id | 404 | `SCENARIO_NOT_FOUND` |
| `TaskMismatchError` (check **before** `ConflictError`; its `code` is `CONFLICT`) | 409 | `TASK_MISMATCH` |
| `ConflictError` from `completeDialog` (pending seqs) | 409 | `PENDING_REQUESTS` (`details.pending_seqs`) |
| `ConflictError` (other) | 409 | `CONFLICT` |
| `InvalidTransitionError` | 409 | `INVALID_TRANSITION` |
| `DialogTerminalError` | 409 | `DIALOG_TERMINAL` |
| Runtime lock held | 409 | `RUNTIME_BUSY` |
| Reset disabled | 403 | `RESET_DISABLED` |
| Unknown route | 404 | `NOT_FOUND` (exists today) |
| Anything else | 500 | `INTERNAL_SERVER_ERROR` (exists today; no stack trace in the body) |

`NotFoundError` has a single `code` (`NOT_FOUND`), so the route decides between `DIALOG_NOT_FOUND` and `REQUEST_NOT_FOUND`: E7 checks that the dialog exists first. The plain `Error('Dialog not found in Adapter A: …')` must never reach the client (Open issue 2).

Adapter B's `error_code`s are **not** HTTP errors. They appear inside a `200 SendResult` with `outcome: "rejected"` (§4).

---

## 6. Events

### 6.1 Delivery: cursor polling
**Recommendation: cursor polling on `GET /api/events?since=<id>`**, not SSE or WebSockets.

- It is testable with plain supertest requests (SSE needs a streaming client).
- It needs no connection management or reconnect logic, and it survives the backend restarting.
- At demo scale (a handful of events per action) a 300–500 ms poll is enough. Each action response also returns its `events` range, so the UI can fetch immediately after a click.

### 6.2 Storage: in-memory ring buffer
- Capacity 1000 events (config `EVENT_BUFFER_SIZE`), with monotonically increasing integer `id`s.
- It survives **simulated** restarts (E10), because the runtime owns it and is not rebuilt.
- It is **lost** when the Node process exits, and cleared by reset (E14), which also changes `epoch`. A client that sees a new `epoch` drops its cursor and re-reads `/api/state`.
- Events are an activity feed, **not** a durable audit log; the durable truth is the three tables. There is no durable events table (no new tables in this phase).

### 6.3 Event shape

```ts
interface ApiEvent {
  id: number;                          // cursor
  at: string;                          // ISO 8601
  type: EventType;
  actor: 'A' | 'B' | 'transport' | 'runtime' | 'scenario';
  dialog_id?: string;
  task_id?: string;
  seq?: number;
  outcome?: string;                    // e.g. 'ok' | 'duplicate' | 'rejected' | state name
  details?: Record<string, unknown>;   // small, JSON-safe
}
```

| `type` | actor | When | `details` |
|---|---|---|---|
| `dialog_created` | A | `startDialog` | `{ state: 'INITIATED' }` |
| `request_sent` | A | `sendRequest`, after the `PENDING` row | `{ attempts }` |
| `retry_sent` | A | `retryRequest` | `{ attempts, send_log_status }` |
| `request_dropped` | transport | request fault fired | `{ fault: 'drop_request' }` |
| `request_processed` | B | B ran the side effect and recorded it | `{ processed_count, side_effects_since_boot }` |
| `duplicate_suppressed` | B | B returned `duplicate` | `{ terminal: boolean }` |
| `request_rejected` | B | B returned `error` | `{ error_code, error }` |
| `response_delivered` | transport | A received the answer | `{ status }` |
| `response_dropped` | transport | response fault fired | `{ fault: 'drop_response', b_status }` |
| `request_acked` | A | send-log row → `ACKED` | — |
| `state_transition` | A or B | any lifecycle change | `{ from, to, reason }` (reason e.g. `first request processed`, `completeDialog`, `retry budget exhausted (attempts n)`, `failDialog: <reason>`) |
| `adapter_restarted` | runtime | E10, start and end | `{ target, scope: 'process', note, phase: 'begin'|'end' }` |
| `dialog_recovered` | A | one per dialog returned by `recover()` | `{ state, next_seq, pending_seqs }` |
| `scenario_started` / `scenario_step` / `scenario_assertion` / `scenario_finished` | scenario | §8 | `{ scenario_id, run_id, text|label, ok, detail, tone }` |
| `runtime_reset` | runtime | E14 | `{ epoch }` |

### 6.4 How Phase 6 emits them, without changing adapter semantics
- **Runtime-level wrappers** around each `AdapterA` call emit `dialog_created`, `request_sent`, `retry_sent`, `request_acked`, `dialog_recovered`, and the `state_transition`s for A-side changes. They compare the dialog state before and after the call; budget exhaustion is detected as `FAILED` after a drop.
- **`ObservedTransport extends Transport`** overrides `registerRequestHandler` to wrap Adapter B's handler. It sees every request B handles **and B's response before a response drop**, so it emits `request_processed` / `duplicate_suppressed` / `request_rejected` (and B's `INITIATED → PROCESSING` transition via a state check). It overrides `sendRequest` to emit `request_dropped`, `response_dropped` and `response_delivered`.
- This needs **no changes to `AdapterA` or `AdapterB`.** Optional small additive changes are listed in Open issue 3.

---

## 7. Side-effect and counter semantics

The tracker (`InMemorySideEffectTracker`) resets on every restart, so a raw "side effects" number would drop to 0 after Scenario 4 and mislead viewers. Every counter is labelled durable or since-boot:

| Field (in `metrics` and/or `DialogSummary`) | Source | Durable | Meaning |
|---|---|---|---|
| `processed_count` | `COUNT(requests)` (per dialog / total via `RequestRepository.countPerDialog`, `totalCount`) | ✔ | Work items B has recorded as processed. **The number the UI shows as "work done".** |
| `transport_attempts` | `SUM(outbound_requests.attempts)` (**new** read-only query) | ✔ | Requests and retries handed to the transport ("packets sent") |
| `dialogs_total`, `by_state{…}` | `DialogRepository.countByState()` | ✔ | Task counts per lifecycle state |
| `restored_total` | `COUNT(dialogs WHERE restored = 1)` (new query, or derive from the dialog list) | ✔ | Dialogs that went through `recover()` |
| `side_effects_since_boot` | tracker | ✘ | Side effects executed by the **current** Adapter B instance. After a restart it starts at 0; staying at 0 on a retried seq shows nothing was re-run. |
| `duplicates_since_boot` | runtime counter (incremented on `duplicate_suppressed`) | ✘ (survives simulated restarts, lost on process exit/reset) | Duplicates blocked. There is no durable store for it. |
| `drops_since_boot` | runtime counter | ✘ | Simulated losses |
| `uptime_ms`, `booted_at`, `restart_count` | runtime | ✘ | Display only |

Expected invariants for the UI and tests: `processed_count ≤ transport_attempts`, and `side_effects_since_boot ≤ processed_count`. The recovery rate shown on the MetricBar becomes `by_state.RECOVERED / restored_terminal`, derived in the UI. It is not the frontend's NACK-based rate.

---

## 8. Scenarios

**Recommendation:** put the five scripts in `backend/src/scenarios/` (one file each plus `index.ts`). Each is an `async (rt: SimulationRuntime, ctx: ScenarioContext) => void` that drives the **live runtime through the same methods the routes use**, so the HTTP API and the scripts share one code path.

```ts
interface ScenarioContext {
  step(text: string, tone?: 'head' | 'info' | 'warn'): void;   // also emits scenario_step
  check(label: string, ok: boolean, detail?: string): void;     // also emits scenario_assertion
  taskId(suffix: string): string;                               // unique per run, e.g. `s4-<run_id>-T1`
  pause(): Promise<void>;                                       // waits step_delay_ms (0 in tests)
}
```

The scripts reproduce the steps and expectations of `tests/scenarios.test.ts`, including the Phase 3b completions:
- Scenario 1: D2 `COMMITTED`, D1 `INITIATED`.
- Scenarios 2–3: `COMMITTED`.
- Scenario 4: restart, then `RECOVERED`.
- Scenario 5: the response-lost variant by default; `body.variant: 'request_lost'` is optional.

`tests/scenarios.test.ts` stays as it is (the adapter-level proof). Phase 6 adds tests that run each script on a temp-file runtime **and** through HTTP.

`ScenarioResult` (response of E12, and `last_result` in E11). It replaces the frontend's `simulation.steps` / `simulation.assertions` / `scenarioResults`:

```ts
interface ScenarioResult {
  scenario_id: 1 | 2 | 3 | 4 | 5;
  run_id: string;
  title: string;
  status: 'passed' | 'failed';          // failed if any check failed or the script threw
  started_at: string;
  duration_ms: number;
  steps: { at: string; text: string; tone: 'head' | 'info' | 'warn' | 'pass' | 'fail' }[];
  assertions: { label: string; ok: boolean; detail: string }[];
  dialogs: { dialog_id: string; task_id: string; final_state: LifecycleState; restored: boolean }[];
  events: { from: number; to: number };
  error?: string;                        // script exception message, if any
}
```

- **Live DB, not isolated.** The created dialogs must appear in the TaskList, and that is the point of the demo. Unique task IDs per run keep runs apart. Side effect: Scenarios 4 and 5 restart the runtime, which marks **all** active dialogs restored (Open issue 5).
- **Already running → `409 RUNTIME_BUSY`.** The run holds the lock for its whole duration.
- **Pacing:** `step_delay_ms` (0–1000) inserts waits between steps so the UI's polling can animate a run. Tests use 0.

---

## 9. Concurrency

Node runs one handler at a time, but adapter calls `await` the transport, so two requests could interleave. **Rule:** one runtime-wide mutex (`runtime.withLock(fn)`).

- Every mutating endpoint (E5–E10, E12, E14) tries to take it. If it is held, the endpoint **fails immediately with `409 RUNTIME_BUSY`**; nothing is queued, so the UI disables controls instead of piling up calls.
- GET endpoints never take the lock. They can observe intermediate state during a scenario run, which is what the live view wants.
- Fault flags are set and cleared inside the lock (§3).
- The lock is in memory and per process; there is one process.

---

## 10. Reset and configuration

New config keys (`config/index.ts`, Phase 6), all from environment variables:

| Key | Env | Default | Purpose |
|---|---|---|---|
| `dbPath` | `DB_PATH` | `<cwd>/dialogs.db` (exists) | SQLite file |
| `maxAttempts` | `MAX_ATTEMPTS` | `5` (= `DEFAULT_MAX_ATTEMPTS`) | Passed to `AdapterA` |
| `allowReset` | `ALLOW_RESET` | `true` unless `NODE_ENV=production` | Enables E14 |
| `eventBufferSize` | `EVENT_BUFFER_SIZE` | `1000` | Ring buffer |

**E14 reset (demo only):**
1. Take the lock.
2. Close the handle.
3. Delete **only** `config.dbPath`, refusing unless the path ends in `.db` and is not `:memory:`.
4. Open a fresh database (the schema is applied automatically) and rebuild the adapters.
5. Clear the events, scenario results and since-boot counters, and issue a new `epoch`.
6. Emit `runtime_reset`.

The body must be `{ "confirm": "RESET" }`. Tests use a temp `DB_PATH` per test file, as the current suites do.

---

## 11. Frontend → backend mapping

Legend: **Served** (endpoint gives it), **Derived** (UI computes from served data), **UI-only** (presentation/animation state, stays in the frontend), **Dropped** (simulation feature not required by PS-021 or not backed by the backend; removed or reworked in Phases 7–8).

### 11.1 Engine return value (`useCorrelationEngine`)

| Field / function | Class | Source / note |
|---|---|---|
| `logs` | Served | E13 events; `narrate.js` is reworked for event `type`s (Phase 7) |
| `wire` | Derived | From E13 events (§11.5 phase map) |
| `dialogs` | Served | E2 / E3 (`DialogSummary`), E4 for detail |
| `nodes` | Served | E2 `nodes` (status only) |
| `metrics` | Served | E2 `metrics` (§7) |
| `throughput` | Derived | Bucket `request_sent`/`retry_sent` events per second (the App does not pass it today) |
| `simulation` | Served | E12 `ScenarioResult` + `scenario_*` events while running |
| `scenarioResults` | Served | E11 `last_result` |
| `dispatch(form)` | Served | E5 + E6 (+ E7 for duplicates) |
| `runScenario(id)` | Served | E12 |
| `runAllScenarios()` | Derived | Five sequential E12 calls |
| `clearLogs()` | UI-only | Hide events up to the current cursor client-side |
| `clearBlackholes()` | Dropped | No standing blackhole; faults are per call |
| `resetEngine()` | Served | E14 |

### 11.2 `dispatch` form fields

| Field | Class | Note |
|---|---|---|
| `dialogId` | Served | Server-generated by E5 (the UI supplies `task_id`) |
| `seq` | Served | Assigned by Adapter A (E6); the UI no longer chooses it |
| `payload` | Served | E6 body |
| `protocol` | Dropped | MCP/A2A tag |
| `delayMs` | Dropped | No artificial latency in the transport |
| `outOfOrder` | Dropped | No reordering |
| `blackhole` | Served | Becomes `fault: "drop_request"` |

### 11.3 Per-dialog view (`toView`)

| Field | Class | Source / note |
|---|---|---|
| `id` | Served | `dialog_id` |
| `taskId` | Served | `task_id` (caller-supplied, not hash-derived) |
| `protocol` | Dropped | — |
| `state` | Served | 5 states only |
| `history` | Derived | `state_transition` events (in-memory; not persisted) |
| `ledger` | Served | E4 `ledger` (per-seq `acked` / `processed_unacked` / `pending_unprocessed`) |
| `appliedOrder` | Served | E4 `processed` ordered by `processed_at` |
| `appliedCount` | Served | `processed_count` |
| `nextSeq` | Served | `next_seq` |
| `buffered` | Dropped | No reorder buffer |
| `missing` | Dropped | No gap detection; `pending_seqs` is the honest analogue |
| `sideEffects` | Served | `processed_count` (durable); `side_effects_since_boot` alongside |
| `suppressed` | Served | `duplicates_since_boot` |
| `restored` | Served | `restored` |
| `restarts` | Derived | Count `adapter_restarted` events (since boot) |
| `createdAt` | Derived | `dialog_created` event time (in-memory; no timestamp column) |
| `terminalAt` | Derived | Terminal `state_transition` event time |
| `latencyMs` | Derived | `terminalAt − createdAt` when both events are present |
| `settled` | Derived | `terminal` |
| `lastTx` | Dropped | Fake transaction ids |
| `envelope` | Dropped | MCP/A2A-style envelope |

### 11.4 `metrics`

| Field | Class | Source / note |
|---|---|---|
| `packets` | Served | `transport_attempts` (durable) |
| `dedup` | Served | `duplicates_since_boot` |
| `suppressed` | Served | Same as `dedup` (the simulation counts both identically) |
| `sideEffects` | Served | `processed_count` total (durable) |
| `recoveryAttempted` | Served | `restored_total` (durable) — redefined: dialogs that went through `recover()` |
| `recoverySucceeded` | Served | `by_state.RECOVERED` (durable) |
| `recoveryRate` | Derived | §7 |
| `activeDialogs` | Served | `by_state.INITIATED + PROCESSING` |
| `totalDialogs` | Served | `dialogs_total` |
| `committed` / `recovered` / `failed` | Served | `by_state.*` |
| `buffered` | Dropped | Reorder buffer |
| `avgLatencyMs` | Derived | From events where available |
| `pps`, `peakPps` | Derived | From event timestamps |
| `walLsn` | Dropped | Fake WAL LSN |
| `durableDialogs` | Served | `dialogs_total` |
| `bootAt` | Served | `runtime.booted_at` |
| `uptimeMs` | Served | `runtime.booted_at` → UI computes |

### 11.5 `nodes`, logs, wire, scenario objects

| Item | Class | Note |
|---|---|---|
| `nodes.*.status` | Served | `online` / `restarting`; `degraded`/`offline` (partition) are dropped |
| `nodes.*.rtt`, `queue`, `writes`, `uptimeMs` | Dropped | Random jitter / fake telemetry |
| log entry `id`, `at`, `dialogId`, `msg`, `meta` | Served | `ApiEvent.id`, `at`, `dialog_id`, `type`(+narration), `details` |
| log entry `ts`, `clock` | Derived | Formatted from `at` |
| log entry `tx` | Dropped | Fake tx ids |
| log entry `kind` | Derived | From `type` (success/duplicate/recovery/error) |
| log entry `layer` | Served | `actor` (adapter-a → `A`, adapter-b → `B`, bridge → `transport`, control → `runtime`; `sqlite` dropped) |
| wire `sent`, `resent` | Derived | `request_sent`, `retry_sent` |
| wire `delivered` | Derived | `request_processed` |
| wire `duplicate` | Derived | `duplicate_suppressed` |
| wire `dropped` | Derived | `request_dropped` / `response_dropped` |
| wire `restored` | Derived | `dialog_recovered` |
| wire `done`, `failed` | Derived | Terminal `state_transition` |
| wire `sorted`, `held`, `nack`, `partition` | Dropped | Reorder buffer / NACK / partition |
| `simulation.running`, `dialogId`, `startedAt`, `durationMs`, `status` | Served | E11 `running`, E12 `ScenarioResult` (`dialogs[]` replaces the single `dialogId`) |
| `simulation.steps`, `assertions` | Served | `ScenarioResult.steps` / `.assertions`, live via `scenario_*` events |
| `scenarioResults[id].status`, `durationMs`, `assertions`, `dialogId`, `at` | Served | `last_result` (`dialogs[]`, `started_at`) |
| `WAITING_ACK` state (constants, TaskList tone, `describeTask`) | Dropped | Frontend-only; never in the API |
| SCENARIOS `protocol` tags, `PROTOCOLS`, `buildEnvelope` | Dropped | Phase 8 |
| SCENARIOS `title`, `tagline`, `description`, `watch`, `Icon`, `tone` | UI-only | Card copy stays in the frontend (titles must match E11) |
| Watchdog / RTO timers, settle timers (`armSettle`) | Dropped | The backend has no timers; completion is explicit (E8) |

---

## 12. Dev wiring

**Recommendation: a Vite dev proxy**, `server.proxy = { '/api': 'http://localhost:3001', '/health': 'http://localhost:3001' }` in `Front/frontend/vite.config.js` (Phase 7). The browser sees one origin, so the backend needs no CORS code and the frontend uses relative URLs (`fetch('/api/state')`). CORS would only be needed for a deployed split origin, which is out of scope.

---

## 13. Build prerequisite

`npm run build` runs `tsc`, which does not copy `src/db/schema.sql` into `dist/`, so `npm start` fails when `db/index.ts` reads `path.join(__dirname, 'schema.sql')`. **Phase 6 step 0:** add a cross-platform copy (e.g. a `postbuild` script using `node -e "require('fs').copyFileSync('src/db/schema.sql','dist/db/schema.sql')"`), and verify `npm run build && npm start` + `GET /health`.

---

## 14. Out of scope

Authentication/authorization, rate limiting, pagination beyond `limit`, API versioning, multi-tenant runtimes, multiple concurrent runtimes, WebSockets and SSE (polling chosen), durable event storage, CORS, OpenAPI generation, raw Adapter B request injection, changing lifecycle/dedup/recovery semantics, separate DB handles per adapter, and closing the side-effect/persist crash window.

---

## 15. End-to-end examples

Example IDs are illustrative; real `dialog_id`s are generated by `AdapterA.startDialog`.

### 15.1 Response lost → retry → duplicate → complete (`COMMITTED`)

```http
POST /api/dialogs
{ "task_id": "task-demo-1" }
```
```json
201 { "dialog": { "dialog_id": "dlg-1791460800000-k3f9q2a", "task_id": "task-demo-1", "state": "INITIATED",
  "restored": false, "terminal": false, "next_seq": 1, "processed_count": 0, "pending_seqs": [],
  "side_effects_since_boot": 0, "duplicates_since_boot": 0 } }
```

```http
POST /api/dialogs/dlg-1791460800000-k3f9q2a/requests
{ "payload": { "op": "charge", "amount": 42 }, "fault": "drop_response" }
```
```json
200 { "dialog_id": "dlg-1791460800000-k3f9q2a", "task_id": "task-demo-1", "seq": 1, "kind": "send",
  "delivery": "response_dropped", "outcome": "no_answer", "response": null,
  "send_log": { "seq": 1, "payload": { "op": "charge", "amount": 42 }, "status": "PENDING", "attempts": 1 },
  "dialog": { "state": "PROCESSING", "processed_count": 1, "pending_seqs": [1], "side_effects_since_boot": 1, "...": "..." },
  "dialog_failed": false, "events": { "from": 2, "to": 5 } }
```
Events 2–5: `request_sent` (A), `request_processed` (B), `state_transition` INITIATED→PROCESSING (B), `response_dropped` (transport, `b_status: "ok"`).

```http
POST /api/dialogs/dlg-1791460800000-k3f9q2a/requests/1/retry
{}
```
```json
200 { "seq": 1, "kind": "retry", "delivery": "delivered", "outcome": "duplicate",
  "response": { "dialog_id": "dlg-1791460800000-k3f9q2a", "task_id": "task-demo-1", "seq": 1, "status": "duplicate",
    "result": { "processed": true, "payload": { "op": "charge", "amount": 42 }, "timestamp": "2026-10-08T07:30:00.000Z" } },
  "send_log": { "seq": 1, "status": "ACKED", "attempts": 2, "...": "..." },
  "dialog": { "processed_count": 1, "pending_seqs": [], "side_effects_since_boot": 1, "duplicates_since_boot": 1, "...": "..." },
  "dialog_failed": false, "events": { "from": 6, "to": 9 } }
```

```http
POST /api/dialogs/dlg-1791460800000-k3f9q2a/complete
```
```json
200 { "dialog": { "state": "COMMITTED", "restored": false, "terminal": true, "...": "..." } }
```

A further `POST …/requests` now returns
`409 { "error": "DIALOG_TERMINAL", "message": "Dialog dlg-… is in terminal state COMMITTED and cannot accept new requests", "status": 409 }`,
while `POST …/requests/1/retry` still returns `200` with `outcome: "duplicate"`.

### 15.2 Adapter A restart → recover → resume → complete (`RECOVERED`)

```http
POST /api/dialogs                                   { "task_id": "task-demo-5" }               → 201, dialog D
POST /api/dialogs/D/requests                        { "payload": { "step": 1 } }               → 200 outcome ok, seq 1
POST /api/dialogs/D/requests                        { "payload": { "step": 2 } }               → 200 outcome ok, seq 2
POST /api/dialogs/D/requests                        { "payload": { "step": 3 }, "fault": "drop_response" }
                                                                                               → 200 response_dropped, seq 3
POST /api/adapters/A/restart
```
```json
200 { "target": "A", "scope": "process",
  "note": "shared store: both adapter objects rebuilt from the SQLite file",
  "recovered": [ { "dialog_id": "D", "task_id": "task-demo-5", "state": "PROCESSING",
                   "next_seq": 4, "pending_seqs": [3] } ] }
```
```http
POST /api/dialogs/D/requests/3/retry               {}                                          → 200 outcome duplicate (stored result, side_effects_since_boot 0)
POST /api/dialogs/D/requests                        { "payload": { "step": 4 } }               → 200 outcome ok, seq 4 (from durable state)
POST /api/dialogs/D/complete
```
```json
200 { "dialog": { "dialog_id": "D", "task_id": "task-demo-5", "state": "RECOVERED", "restored": true,
  "terminal": true, "processed_count": 4, "side_effects_since_boot": 1, "...": "..." } }
```

### 15.3 Scenario run

```http
POST /api/scenarios/3/run
{ "step_delay_ms": 0 }
```
```json
200 { "scenario_id": 3, "run_id": "run-7", "title": "Scenario 3 — Response Lost → Duplicate Request",
  "status": "passed", "started_at": "2026-10-08T07:31:00.000Z", "duration_ms": 12,
  "steps": [ { "at": "…", "text": "Create D1/T1", "tone": "head" },
             { "at": "…", "text": "Send seq 1 — response dropped after B processed it", "tone": "warn" },
             { "at": "…", "text": "Retry seq 1", "tone": "info" } ],
  "assertions": [ { "label": "retry classified as duplicate", "ok": true, "detail": "status=duplicate" },
                  { "label": "side effect not repeated", "ok": true, "detail": "processed_count=1" },
                  { "label": "dialog COMMITTED", "ok": true, "detail": "state=COMMITTED" } ],
  "dialogs": [ { "dialog_id": "dlg-…", "task_id": "s3-run-7-T1", "final_state": "COMMITTED", "restored": false } ],
  "events": { "from": 40, "to": 52 } }
```

---

## 16. Phase 6 implementation checklist

Ordered; each step should be reviewable on its own and keep the existing 142 tests green.

1. **Build fix:** copy `schema.sql` into `dist/`; verify `npm run build && npm start` + `/health`.
2. **Config:** `maxAttempts`, `allowReset`, `eventBufferSize` (§10).
3. **Read-only queries:** `OutboundRequestRepository.findByDialog`, `sumAttempts`; `restored` count. Unit tests.
4. **`EventLog`** ring buffer (append, `since`, `limit`, `epoch`, eviction). Unit tests.
5. **`ObservedTransport`** subclass emitting transport/B events (§6.4). Unit tests.
6. **`SimulationRuntime`:** boot (+ `recover()`), lock, `startDialog/send/retry/complete/fail` wrappers returning `SendResult`, `restart(target)`, `reset()`, snapshot builders. Unit tests using a temp `DB_PATH`, including a restart that verifies the data came from the file.
7. **Error middleware:** the §5 mapping, zod → 400, the `RUNTIME_BUSY` / `RESET_DISABLED` codes; the runtime pre-check for terminal/undriven dialogs (Open issue 2).
8. **Routes** E2–E14 with zod schemas; `createApp(runtime)`; `server.ts` builds the runtime.
9. **Scenario module** `backend/src/scenarios/` (five scripts, `ScenarioContext`), plus tests running each script on a temp-file runtime.
10. **API tests (supertest):** every endpoint's success and error paths; all five scenarios via the HTTP call sequence (not only E12); events cursor and epoch; the lock (409 during a scenario run); reset.
11. **Docs:** README §19, §24 and §25 updated with the real API.

---

## 17. Open issues

> **Resolved in Phase 6** (approved decisions):
> 1. Accepted: full process restart for both targets.
> 2. Option (a): the runtime pre-checks and maps to `DIALOG_TERMINAL`/`NOT_FOUND`; Adapter A is unchanged.
> 3. Skipped: no `messageType` on `MessageDroppedError`.
> 4. Accepted: `duplicates_since_boot` is not durable.
> 5. Scenarios run on the live DB.
> 6. Deferred to Phases 7–8.
> 7. Accepted: no timestamp columns.
> 8. Deferred to the mentor.
> 9. Accepted: reset is on by default outside production.
>
> The original list follows for reference.

1. **Restart granularity.** With one shared handle, "restart A" and "restart B" are both full process restarts. Every active dialog becomes `restored` and later completes as `RECOVERED`. Accept this (recommended, matches the tests) or fund separate handles per adapter (out of scope today)?
2. **Adapter A's untyped "not driven" error.** `AdapterA.requireLocalDialog` throws a plain `Error`. After `recover()` this only happens for terminal dialogs, e.g. `complete` or `fail` on a finished dialog, which would surface as `500`. Options: (a) the runtime pre-checks state and maps it to `409 DIALOG_TERMINAL` (no backend change; recommended), or (b) introduce a typed `DialogNotDrivenError` in `AdapterA` (an error-class change, no semantic change).
3. **Optional additive adapter/transport changes:** a `readonly messageType` on `MessageDroppedError`. With the observing transport the runtime does not need it. Approve or skip?
4. **Duplicate counts are not durable.** `duplicates_since_boot` is lost on process exit and reset. A durable count would need a new column or table, which is excluded so far. Accept?
5. **Scenarios on the live DB.** Runs are visible in the UI, but Scenarios 4 and 5 restart the runtime and mark unrelated active dialogs `restored`. Alternative: run scenarios on an isolated temp DB (no TaskList entries). Recommended: live.
6. **Manual "Send packets" semantics change (Phase 7/8).** "Deliver out of order" disappears; "lose one" becomes `drop_request` and needs an explicit retry (no NACK auto-heal); a dialog needs an explicit "complete" (no auto-settle).
7. **No timestamps in `dialogs`.** `createdAt`/`latencyMs` exist only while the events are in the ring buffer. Adding columns would change the schema; not proposed.
8. **"Interoperability results"** (PS expected outcome) is still undefined. The API does not change that.
9. **Reset default.** `ALLOW_RESET` defaults to on outside `production`. Is that acceptable for the demo machine?
