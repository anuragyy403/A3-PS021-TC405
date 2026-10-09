# Nighthawks — PS-021 Project Context

**Last Updated:** 2026-10-09 — Phases 0–9 complete (backend, HTTP API, dashboard driven by the API, browser E2E tests + docs/TEST_RESULTS.md); next: Phase 10 (demo)
**Team:** Nighthawks
**Project:** PS-021: Experimental Dialog Correlation and Recovery Across Agent Adapters
**Category:** AIORI-3 / 6G & Future Networks

---

## Purpose of This Document

This document lets a new working session understand the project without repeating the analysis. It records what exists in the code **now**, the decisions behind it, and the phase plan.

**The code is the source of truth.** If this document disagrees with `backend/src/`, the code wins and this document must be fixed. Earlier versions of this file (Phase 1) described a planned design that changed during implementation. Statements that are no longer true are marked **(outdated)**.

**READ THIS FIRST** before working on any implementation task, then read `README.md` and `docs/EXPERIMENTAL_SCHEMA.md`.

---

## 1. Project Identity

### What We Are Building

An experimental prototype demonstrating how two mock agent adapters can maintain dialog/task identity, lifecycle state, correlation, deduplication, and recovery when communication fails or an adapter restarts.

### Framing

- This is an **EXPERIMENTAL PROTOTYPE** for a hackathon
- Inspired by emerging IETF agent-protocol discussions
- Does **NOT** claim to be a finalized IETF standard
- Does **NOT** claim complete MCP/A2A interoperability
- Does **NOT** claim universal exactly-once delivery

### Problem Statement (Official)

> "Multi-agent AI systems frequently communicate across distinct frameworks, such as Anthropic's Model Context Protocol (MCP) and Google's Agent2Agent (A2A), that manage conversation context in proprietary ways. When an agent restarts or a network disconnects during a task, the absence of standardized dialog tracking leads to lost context and duplicate operations."

The official PS PDF is **not stored in the repository** (it was provided separately).

---

## 2. Official PS-021 Requirements

### Required by PS (R1-R8)

| # | Requirement | Source |
|---|---|---|
| R1 | Implement 2 mock agent adapters | PDF |
| R2 | Use 1 defined dialog-state schema | PDF |
| R3 | Preserve task identity across adapter restarts | PDF |
| R4 | Implement request deduplication to prevent duplicate side effects | PDF |
| R5 | Test 5 disconnect/retry scenarios | PDF |
| R6 | Define explicit lifecycle states and valid state transitions | PDF |
| R7 | Use a mentor-selected, pinned draft or clearly labelled experimental schema | PDF |
| R8 | No claim of final IETF-standard implementation, complete MCP/A2A interoperability, or universal exactly-once delivery | PDF |

### Expected Demonstration

"Demonstration showing task identity preservation and duplicate-side-effect rejection"

### Not Required (Implementation Choices)

- Backend language — Node.js/TypeScript
- Database technology — SQLite file via sql.js
- Web framework — Express (HTTP API implemented in Phase 6, `docs/API_DESIGN.md`)
- Frontend↔backend protocol — REST + cursor polling of `/api/events` (no SSE)
- Whether adapters are separate processes — single process, logical modules
- Specific lifecycle state names — 5-state backend model (§5)
- Specific scenario definitions — five failure experiments (§9)

---

## 3. Core Concepts

### Dialog

A bounded exchange between two agents about a piece of work. Has a unique `dialog_id`. One row in `dialogs`.

**NOT:** chat history, model memory, conversation transcript.
**IS:** coordination record, state container, correlation key.

### Correlation

Determining which existing dialog/task an incoming message belongs to.

**Key question:** "Which dialog does this request belong to?"
**Mechanism:** `DialogManager.correlate(dialog_id, task_id)` — look up `dialog_id`, verify `task_id` matches. Unknown → `DIALOG_NOT_FOUND`; mismatch → `TASK_MISMATCH`.

### Task Identity

The identity of the unit of work, represented by `task_id`, supplied by the caller of `AdapterA.startDialog(taskId)`.

**Key requirement (R3):** `task_id` must be preserved across restart. After restart, the system continues the same task, not a new one.

### Durable State

State stored so it survives a process restart: one SQLite file.

- **Runtime memory:** lost on restart (Adapter A's set of driven dialogs, transport flags, side-effect counter, sql.js in-memory DB copy)
- **Durable storage:** the `.db` file, rewritten after every mutation

**What is durable:** `dialogs`, `requests` (B's processed ledger), `outbound_requests` (A's send log).

### Deduplication

Recognizing that a request was already processed and not executing the side effect again.

**Key question:** "Have I already processed this `(dialog_id, seq)`?"
**Mechanism:** Adapter B looks up `(dialog_id, seq)` in `requests`; if present, returns the stored result as `duplicate`.
**Purpose:** Prevent duplicate side effects (R4) — when the original request has already been durably recorded as processed.

### Recovery

Restoring dialog/task state after a restart.

**Mechanism:** Reopen the SQLite file. Adapter B needs no extra step. Adapter A calls `recover()`: every `INITIATED`/`PROCESSING` dialog is marked `restored`, driven again, and reported with `nextSeq = MAX(seq)+1` and its `PENDING` seqs.

---

## 4. Identifier Model

Three identifiers. **There is no `request_id`** — the earlier plan for one was replaced by `seq`.

### `dialog_id`

- **Purpose:** Uniquely identifies one dialog
- **Used for:** Correlation
- **Generated by:** Adapter A, `dlg-<Date.now()>-<7 base-36 chars>`

### `task_id`

- **Purpose:** Identifies the unit of work
- **Used for:** Task identity preservation (R3); checked on every request
- **Generated by:** the caller of `startDialog(taskId)`
- **(outdated)** "Deterministically derived from `dialog_id` (FNV-1a hash)" — was true only in the old frontend simulation (`deriveTaskId`, removed in Phase 8), never in the backend.

### `seq`

- **Purpose:** Identifies one logical request within a dialog
- **Used for:** Deduplication (R4)
- **Generated by:** Adapter A, `MAX(seq in outbound_requests) + 1` per dialog
- **Retry rule:** a retry keeps `dialog_id`, `task_id`, `seq` and the stored payload

### Composite Keys

- **Correlation key:** `dialog_id` (+ `task_id` equality check)
- **Deduplication key:** `(dialog_id, seq)`
- `D1`/seq 1 and `D2`/seq 1 are different requests

---

## 5. Lifecycle State Machine

### Backend Model (implemented)

```typescript
type LifecycleState = 'INITIATED' | 'PROCESSING' | 'COMMITTED' | 'RECOVERED' | 'FAILED';
```

| From | To | Triggered by |
|---|---|---|
| — | `INITIATED` | `AdapterA.startDialog` |
| `INITIATED` | `PROCESSING` | Adapter B, first new `(dialog_id, seq)` processed |
| `INITIATED` / `PROCESSING` | `FAILED` | Adapter A retry budget (`maxAttempts`, default 5, unanswered attempts of a `PENDING` request) or `AdapterA.failDialog` |
| `PROCESSING` | `COMMITTED` | `AdapterA.completeDialog`, `restored = false`, nothing `PENDING` |
| `PROCESSING` | `RECOVERED` | `AdapterA.completeDialog`, `restored = true` (set by `recover()`), nothing `PENDING` |
| `COMMITTED` / `RECOVERED` / `FAILED` | — | Terminal |

Terminal-state protection:
- Adapter A `sendRequest` on a terminal dialog → `DialogTerminalError` before assigning a seq.
- Adapter A `retryRequest` on a terminal dialog → allowed only for logged seqs; state unchanged.
- Adapter B: already-processed seq → `duplicate` (even if terminal); new seq → `error` / `DIALOG_TERMINAL`.

**Any change to the backend lifecycle requires an explicit architectural decision.** Never add `WAITING_ACK` to the backend.

### Frontend Model

Since Phase 8 the dashboard shows exactly the backend's five states and transition table (`Front/frontend/src/lib/constants.js`, checked against `backend/src/types/index.ts` by `tests/mappers.mjs`). The old simulation's `WAITING_ACK` state is gone from the UI.

### How Recovery Fits

1. Restart: reopen the file.
2. `AdapterA.recover()` loads `INITIATED`/`PROCESSING` dialogs, sets `restored = true`; state stays the same.
3. When the task completes, `completeDialog` moves it to `RECOVERED` (not `COMMITTED`).
4. `RECOVERED` therefore means "completed after a restart and recovery".

---

## 6. Adapter Architecture

### Design: Two Logical Modules in One Node.js Process

```
Single Node.js process (tests today; Express server later)
├── AdapterA        (src/adapters/AdapterA.ts)
├── Transport       (src/adapters/Transport.ts — in-process, fault injection)
├── AdapterB        (src/adapters/AdapterB.ts)
├── DialogManager   (src/services/DialogManager.ts — shared logic)
├── Repositories    (Dialog, Request, OutboundRequest)
└── sql.js handle → one SQLite file (shared by both adapters)
```

### Why Single Process?

- PS-021 only requires "two mock agent adapters" (not separate OS processes)
- Simpler for hackathon timeline
- Easier demonstration
- Sufficient realism: a "restart" discards all in-memory objects and reopens the file

### Adapter Responsibilities (implemented)

**Adapter A (sender):**
- `startDialog(taskId)` — create dialog (`INITIATED`)
- `sendRequest` — seq from send log, `PENDING` row written before sending, `ACKED` on `ok`/`duplicate`
- `retryRequest(dialogId, seq)` — same IDs, stored payload, `attempts + 1`
- `recover()` — resume active dialogs after restart
- `completeDialog` — `COMMITTED` / `RECOVERED`
- `failDialog`, retry budget — `FAILED`

**Adapter B (receiver):**
- correlate → dedup check → terminal check → side effect → record → `INITIATED → PROCESSING`
- responds `ok` / `duplicate` / `error` + `error_code`

**DialogManager:** create/retrieve, `correlate`, validated `transition`, `markRestored`, `transitionToRecovered`. No deduplication.

**Repositories:** SQL only; persist after every mutation.

### Symmetric vs. Asymmetric

**Design is asymmetric:** Adapter A sends, Adapter B receives; `Transport` delivers A → B only. This is a property of the prototype, not a protocol rule; revisit only by explicit decision.

---

## 7. Backend Technology Stack (implemented)

| Technology | Purpose | Note |
|---|---|---|
| **Node.js 20+** | Runtime | Verified on v24.14.1 |
| **TypeScript (strict)** | Language | |
| **Express 4** | Web framework | Only `GET /health` |
| **sql.js 1.12** | SQLite driver (WebAssembly) | Used because better-sqlite3 needs a C++ build toolchain that is unavailable on the development machine |
| **SQLite file** | Durable storage | In memory while running; whole DB written to the file after every mutation |
| **Zod** | Validation schemas | Record schemas defined; API use comes later |
| **Vitest 1.6** (+ supertest) | Testing | 14 files, 265 tests |

**(outdated)** "better-sqlite3 — approved driver", "pino (optional)", "True ACID persistence" and "synchronous API": sql.js is in use; durability comes from `persistToDisk` (a non-atomic in-place file write), not from SQLite's journal.

### Libraries NOT Needed

❌ Prisma ❌ Redis ❌ Docker ❌ Message queue

---

## 8. Dialog-State Schema (implemented)

Full definition: **`docs/EXPERIMENTAL_SCHEMA.md`** (v0.1-experimental — the R7 artifact). Source: `backend/src/db/schema.sql`, `backend/src/types/index.ts`.

```sql
CREATE TABLE dialogs (
  dialog_id TEXT NOT NULL PRIMARY KEY,
  task_id   TEXT NOT NULL,
  state     TEXT NOT NULL DEFAULT 'INITIATED' CHECK (state IN (5 states)),
  restored  INTEGER NOT NULL DEFAULT 0 CHECK (restored IN (0,1))
);
CREATE TABLE requests (            -- Adapter B processed ledger
  dialog_id TEXT NOT NULL REFERENCES dialogs(dialog_id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  processed_at TEXT NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY (dialog_id, seq)
);
CREATE TABLE outbound_requests (   -- Adapter A send log
  dialog_id TEXT NOT NULL REFERENCES dialogs(dialog_id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACKED')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  PRIMARY KEY (dialog_id, seq)
);
```

**(outdated)** Phase 1 planned `created_at`/`updated_at` on dialogs and a `request_id` column, and listed `sequence_no` and `attempt` as excluded. The implementation has no timestamps on `dialogs`, uses `seq` instead of `request_id`, and keeps `attempts` in Adapter A's send log.

Still excluded: `payload_digest`, `protocol`, `buffered`, transition history, failure reason.

---

## 9. Approved Five Scenarios (implemented in `backend/tests/scenarios.test.ts`)

| # | Name | What happens | Ends |
|---|---|---|---|
| 1 | Multiple Dialogs + Retry → Correct Correlation | D1/T1 and D2/T2; D2 seq 1 dropped and retried; correlated to D2, processed once, D1 untouched | D2 `COMMITTED`, D1 `INITIATED` |
| 2 | Request Lost → Retry | seq 1 dropped before B, retried, processed once | `COMMITTED` |
| 3 | Response Lost → Duplicate Request | B processes seq 1, response dropped, retry → `duplicate`, count stays 1 | `COMMITTED` |
| 4 | Adapter B Restart → Durable State Recovery | response dropped, full restart, `recover()` (nextSeq 2, pending [1]), retry → `duplicate` | `RECOVERED` |
| 5 | Mid-Task Disconnect + Adapter A Restart → Resume | seq 1–2 ok, seq 3 response-lost **or** request-lost, restart, `recover()` (nextSeq 4, pending [3]), retry 3, send 4 | `RECOVERED` |

**(outdated)** Phase 1 described Scenario 1 as interleaved R1/R2 across both dialogs ending with both `COMMITTED`, and used `R1/R2` request names. The implemented test is as in the table.

### How the Five Fit Together

```
Scenario 1 → Can we identify the correct dialog?             CORRELATION
Scenario 2 → What if the request never arrives?              RETRY HANDLING
Scenario 3 → What if the request arrived but response didn't? DEDUPLICATION
Scenario 4 → What if the process restarts after B processed? DURABLE RECOVERY
Scenario 5 → What if Adapter A restarts mid-task?            TASK IDENTITY + RESUME
```

---

## 10. Frontend Audit Summary (Phase 0 findings — **(outdated)** since Phase 8, kept as history)

**Phase 8 (2026-10-09):** `useCorrelationEngine.js`, `protocol.js`, `tests/conformance.mjs` and the `VITE_ENGINE` switch were deleted. The dashboard (`package.json` name `nighthawks-dashboard`) is driven only by `src/api/useBackendEngine.js`; tests are `tests/mappers.mjs`, `tests/messages.mjs`, `tests/backendEngine.mjs`. Everything below describes the pre-Phase-8 simulation.

### Current Repository Structure

```
Nighthawks/
├── README.md
├── KIRO_PROJECT_CONTEXT.md
├── docs/EXPERIMENTAL_SCHEMA.md
├── backend/                     (implemented core — see README §22)
└── Front/frontend/              (React + Vite + Tailwind)
    ├── package.json             (name: nighthawks-adapter-a)
    ├── src/
    │   ├── App.jsx
    │   ├── lib/
    │   │   ├── constants.js           (states, transitions, scenarios, timing)
    │   │   ├── protocol.js            (deriveTaskId, correlationKey, MCP-/A2A-style envelopes)
    │   │   ├── useCorrelationEngine.js (~1400 lines — the simulation engine)
    │   │   ├── narrate.js             (log → plain English)
    │   │   └── format.js
    │   └── components/
    └── tests/conformance.mjs           (headless jsdom harness)
```

### Key Finding (Phase 0–7): Frontend Contained Its Own Simulation Engine

`useCorrelationEngine.js` is a complete in-browser simulation, **not connected to the backend**:
- Dialog creation; `task_id` derived from `dialog_id` (FNV-1a)
- Six lifecycle states including `WAITING_ACK`
- Dedup per dialog on `seq` (`dialog.seen[seq]`); the displayed `correlationKey` string also contains the attempt number
- "Durable" storage is an in-browser JavaScript `Map` (logs mention "WAL"/"SQLite", but nothing is written to disk)
- Simulated crash/recovery (`killAdapter`, `coldStartAdapter`); one dialog map serves both "adapters"
- Reorder buffer, NACK gap healing, RTO watchdog
- MCP-style / A2A-style envelopes for visualization only
- The five scenario cards now use the approved scenario names

**(outdated)** "Frontend scenarios: Normal Transmission, Out-of-Order Packets, System Crash, Duplicate Guard, Missing Packet" — replaced by the five approved scenarios in `constants.js`.

**Phase 4 change:** the three UI strings that said "exactly once" (`constants.js` COMMITTED hint and receiver description, `narrate.js` work-item line) were reworded. No frontend logic was changed.

### Frontend vs. Backend

| Aspect | Frontend simulation | Backend |
|---|---|---|
| Lifecycle | 6 states (incl. `WAITING_ACK`) | 5 states |
| Identifiers | `dialog_id`, derived `task_id`, `seq` | `dialog_id`, caller-supplied `task_id`, `seq` |
| Dedup key | `(dialog_id, seq)` in memory | `(dialog_id, seq)` in SQLite |
| Durable storage | JS `Map` | SQLite file (sql.js) |
| Reorder buffer / NACK | Yes | No |
| Connected | No | — |

---

## 11. Backend ↔ Frontend Boundary

### Backend Owns (authoritative PS-021 behaviour)

Adapters, dialog state, lifecycle, correlation, deduplication, persistence, recovery, scenario execution, side-effect tracking, APIs.

### Frontend Owns (visualization and interaction)

Dashboard layout, metrics, pipeline visualizer, scenario hub, task list, activity feed, narration, manual controls, presentation utilities, API client and polling (`useBackendEngine`). No experiment state.

### API (implemented in Phase 6)

Contract: `docs/API_DESIGN.md` (its "Implementation status" section lists every deviation). Endpoints: `GET /health`, `GET /api/state`, `GET /api/dialogs[/:id]`, `POST /api/dialogs`, `POST /api/dialogs/:id/requests`, `POST /api/dialogs/:id/requests/:seq/retry`, `POST /api/dialogs/:id/complete|fail`, `POST /api/adapters/:A|B/restart`, `GET /api/scenarios`, `POST /api/scenarios/:id/run`, `GET /api/events?since=`, `POST /api/reset`. Routes call only `SimulationRuntime` (`backend/src/runtime/`).

---

## 12. Current Project Status

```
✅ Phase 0: Repository audit
✅ Phase 1: Backend architecture & design
✅ Phase 2: Backend foundation — storage, DialogManager, adapters, transport,
            five scenario tests
✅ Phase 3a: Adapter A durable send log + recover()           (commit fc67906)
✅ Phase 3b: Lifecycle completion + terminal-state protection (commit 0a8b295)
✅ Phase 4: Documentation alignment + docs/EXPERIMENTAL_SCHEMA.md      (commit 975b2ff)
✅ Phase 5: API design — docs/API_DESIGN.md                            (commit b548274)
✅ Phase 6a: SimulationRuntime, EventLog, ObservedTransport, build fix (commit 85032b4)
✅ Phase 6b: HTTP routes, validation, error mapping                    (commit f2b50bd)
✅ Phase 6c: Scenario module, E11/E12, five scenarios via HTTP, docs (commit 29e1197)
✅ Phase 7a: API client, polling engine hook, Vite proxy                (commit 2e84bfe)
✅ Phase 7b: Manual controls, error UX, honest wording, hook tests      (commit 918957d)
✅ Phase 8: Frontend cleanup — simulation removed, one backend model   (commit 8b4b1f7)
✅ Phase 9: Browser E2E (e2e/, Playwright + local Edge, 16 tests) and
            docs/TEST_RESULTS.md
⏸ Phase 10: Demo   ← NEXT
⏸ Phase 11: Final deliverables (PDF per Proposed-structure-hackathon.pdf,
             repo hand-over to aiori-hackathon)
```

Backend tests: 14 files, 265 passing. Frontend `npm test`: mappers 33, messages 8, backendEngine 23. Browser E2E (`e2e/`, `npm run e2e`): 16 passing (2026-10-09). Results: `docs/TEST_RESULTS.md`.

---

## 13. Development Roadmap

| Phase | Scope | Notes |
|---|---|---|
| 4 | Docs match the code; experimental schema artifact; no behaviour changes | README, this file, schema doc, stale comments, frontend "exactly once" wording |
| 5 | API design | Endpoints, payloads, error mapping (`error_code`), restart/reset semantics, event stream |
| 6 | API implementation | Express routes over the existing adapters; tests |
| 7 | Frontend integration | Replace the simulation engine's authority with backend calls |
| 8 | Frontend cleanup | MCP/A2A envelopes and labels, `WAITING_ACK`, "WAL/SQLite" wording in simulation logs |
| 9 | End-to-end tests | Through the API (and UI where practical) |
| 10 | Demo | Script, live run, pseudocode snippet |
| 11 | Final deliverables | PDF, repository structure, ownership transfer |

---

## 14. Development Rules

### Permanent Rules for All Sessions

1. **Read this document first** before any implementation work
2. **Read the official PS-021 PDF** before major implementation
3. **Never silently change approved architecture** — document and discuss conflicts
4. **Work phase-by-phase** — complete one phase before starting next
5. **Inspect before modifying** — read existing code before changing it
6. **Do not over-engineer** — this is a hackathon prototype, not production
7. **Preserve useful existing work** — the removed frontend simulation stays available in git history
8. **Test important behavior** — five scenarios must be demonstrable
9. **Do not claim universal exactly-once** — acknowledge crash window limitation
10. **Do not claim final IETF compliance** — experimental schema only
11. **Do not claim complete MCP/A2A interoperability** — the prototype uses two mock adapters; no MCP/A2A in the UI
12. **Do not implement future phases early** — respect incremental development
13. **Stop after each phase** and wait for approval before proceeding
14. **Clearly distinguish** current implementation from planned architecture
15. **The code is the source of truth** — update docs when code changes

### When Starting a New Session

1. Read this document, then `README.md` status banner and `docs/EXPERIMENTAL_SCHEMA.md`
2. Check current project status (§12) and `git log`
3. Confirm which phase you are working on
4. Run `npm run typecheck` and `npm test` in `backend/`
5. Identify conflicts between docs and code; report them, don't silently resolve them

### When Architecture Questions Arise

1. Check this document and the code
2. If still unclear, ask the user before implementing
3. Document the decision once made

---

## 15. Known Limitations and Non-Claims

### What We ARE Demonstrating

✅ Dialog identity preservation across restart
✅ Task identity preservation (same `task_id` after restart)
✅ Lifecycle state preservation and completion as `RECOVERED` after restart
✅ Duplicate-side-effect prevention when the original request has already been durably recorded as processed
✅ Valid lifecycle transitions enforced, invalid ones rejected
✅ Terminal dialogs refuse new work but replay processed requests
✅ Five disconnect/retry scenarios
✅ Durable state survives restart (SQLite file)

### What We Are NOT Claiming

❌ Universal exactly-once delivery
❌ Closing the crash window between side effect and persistence
❌ Concurrent duplicate handling
❌ Real MCP/A2A interoperability
❌ IETF standard implementation
❌ Production readiness
❌ Distributed consensus, Byzantine fault tolerance
❌ Authentication/authorization, encryption

### Stated Limitations

1. **Crash window:** Adapter B runs the side effect before persisting the processed record; a crash in between repeats the side effect on retry
2. **Simulated failures:** restarts are simulated by discarding objects and reopening the file
3. **Single process, shared store:** both adapters share one sql.js handle and one file
4. **In-process transport:** drop-next-request / drop-next-response only
5. **Non-atomic persistence:** `persistToDisk` overwrites the file in place
6. **Retry budget** also counts attempts that got an `error` reply
7. **Side-effect counter** is in memory
8. **Mock agents** only
9. **API is local and unauthenticated:** one runtime and one lock; mutations during a scenario run get `409 RUNTIME_BUSY`; activity events are in memory only (the Phase 4 build gap — `schema.sql` not copied to `dist/` — was fixed in 6a)

---

## 16. Reference Material

### Source Documents

- **Official PS-021 PDF** (provided separately; not in the repository)
- **README.md** — project documentation aligned with the code (Phase 4)
- **docs/EXPERIMENTAL_SCHEMA.md** — experimental dialog-state schema v0.1

### Frontend Reference

`Front/frontend/src/lib/useCorrelationEngine.js` is a reference for visualization, scenario orchestration patterns and event logging structure. **Do NOT copy blindly** — its persistence, task-id derivation, lifecycle and reorder logic differ from the backend.

### Key Files

- Backend: `src/types/index.ts`, `src/db/schema.sql`, `src/services/DialogManager.ts`, `src/adapters/*.ts`, `tests/scenarios.test.ts`, `tests/lifecycle.test.ts`
- Frontend: `src/lib/constants.js`, `src/lib/protocol.js`, `src/lib/useCorrelationEngine.js`, `tests/conformance.mjs`

---

## 17. Important Architectural Points

### Why `dialog_id` and `task_id` Are Separate

The PS distinguishes "dialog" (exchange) from "task" (work). After a restart we must show the same task continues. Separate identifiers make this explicit.

### Why `seq` Is the Request Identity

`seq` distinguishes "first request", "second request" and "retry of the first request" within a dialog, and Adapter A can derive the next value from its durable send log. The dedup key is `(dialog_id, seq)`. **(outdated)** The Phase 1 plan used a separate `request_id`; it was not implemented.

### Why SQLite Instead of In-Memory

An in-memory map does not survive a process restart. The SQLite file does, which makes the "durable state" claim honest (R3).

### Why sql.js Instead of better-sqlite3

better-sqlite3 needs a native C++ build toolchain that is not available on the development machine. sql.js needs none; the trade-off is that the whole database is written to the file after each mutation.

### Why an Adapter A Send Log

Without it, a restarted Adapter A cannot know the next `seq` or which requests were in flight, and tests would have to pass `nextSeq` in by hand.

### Why Single Process Instead of Two Processes

PS-021 requires "two mock agent adapters", not two OS processes. One process is simpler, easier to debug, and sufficient for demonstrating recovery.

### Why Six Lifecycle States in Frontend, Five in Backend

The frontend's `WAITING_ACK` supports its quiet-period settle animation. PS-021 does not require it, and the backend goes directly from `PROCESSING` to a terminal state. Whether the frontend keeps it is a Phase 8 decision; the backend never adds it.

---

## 18. Success Criteria

### Demo Must Show

1. Two mock adapters functioning
2. Dialog correlation (multiple dialogs stay isolated)
3. Task identity preserved across restart
4. Request deduplication preventing duplicate side effects
5. Lifecycle states and valid transitions enforced
6. Durable state surviving restart
7. Five scenarios with expected outcomes
8. Logs/metrics showing correlation, deduplication, recovery events

### Code Must Demonstrate

- ✅ Dialog schema matching `docs/EXPERIMENTAL_SCHEMA.md`
- ✅ State machine rejecting invalid transitions
- ✅ Deduplication keyed on `(dialog_id, seq)`
- ✅ SQLite persistence of dialogs, requests and the send log
- ✅ Recovery of non-terminal dialogs after restart (`AdapterA.recover()`)
- ✅ Scenario orchestration exposed through the API (`POST /api/scenarios/:id/run`)
- ✅ REST API + polled event stream for frontend integration (wiring the UI is Phase 7)

### Documentation Must Include

- ✅ Clear statement this is an experimental prototype
- ✅ No claim of IETF standard compliance
- ✅ No claim of universal exactly-once delivery
- ✅ No claim of complete MCP/A2A interoperability
- ✅ Acknowledgment of the crash window limitation
- ✅ Pseudocode snippet (README §20)
- ✅ Requirements traceability (README §29)

---

## End of Project Context Document

**Current Status:** Phases 0–6 complete. Next: Phase 7 (frontend ↔ backend integration).

**Last Updated:** 2026-10-08
