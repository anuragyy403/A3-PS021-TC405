# Nighthawks — PS-021 Project Context

**Last Updated:** Phase 1 Complete (Backend Architecture Approved)  
**Team:** Nighthawks  
**Project:** PS-021: Experimental Dialog Correlation and Recovery Across Agent Adapters  
**Category:** AIORI-3 / 6G & Future Networks

---

## Purpose of This Document

This document preserves the completed Phase 0 audit and Phase 1 architecture so that future Kiro sessions can understand the project without repeating the entire analysis. All architecture decisions below have been reviewed and approved.

**READ THIS FIRST** before working on any implementation task.

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

- Backend language (we chose Node.js/TypeScript)
- Database technology (we chose SQLite)
- Web framework (we chose Express)
- Communication protocol (we chose REST + SSE)
- Whether adapters are separate processes (we chose single process, logical modules)
- Specific lifecycle state names (we chose existing frontend model)
- Specific scenario definitions (we defined five experiments)

---

## 3. Core Concepts

### Dialog

A bounded exchange between two agents about a piece of work. Has a unique `dialog_id`.

**NOT:**
- Chat history
- Model memory
- Conversation transcript

**IS:**
- Coordination record
- State container
- Correlation key

### Correlation

Determining which existing dialog/task an incoming message belongs to.

**Key question:** "Which dialog does this request belong to?"

**Mechanism:** Match incoming `dialog_id` to stored dialog records.

### Task Identity

The identity of the unit of work being performed. Represented by `task_id`.

**Key requirement (R3):** `task_id` must be preserved across adapter restart. After restart, the system must continue the same task, not create a new one.

### Durable State

State stored so it survives a process restart.

**Key distinction:**
- **Runtime memory:** Lost on crash/restart
- **Durable storage:** Survives restart (SQLite file on disk)

**What must be durable:**
- Dialog records (identity, task_id, lifecycle state)
- Request records (processed requests for deduplication)

### Deduplication

Recognizing that a request was already processed and not executing the side effect again.

**Key question:** "Have I already processed this exact request?"

**Mechanism:** Check if `(dialog_id, request_id)` exists in requests table.

**Purpose:** Prevent duplicate side effects (R4).

### Recovery

Restoring dialog/task state after an adapter restart.

**Mechanism:** On startup, load all active (non-terminal) dialogs from durable storage into runtime memory.

**Result:** Adapter can correlate incoming retries and continue existing tasks.

---

## 4. Identifier Model

Three identifiers form the backbone of the system:

### `dialog_id`

- **Purpose:** Uniquely identifies one dialog (bounded exchange)
- **Used for:** Correlation (finding existing dialog)
- **Example:** `D123`
- **Could it be removed?** No. Without it, correlation is impossible.

### `task_id`

- **Purpose:** Identifies the unit of work being performed
- **Used for:** Task identity preservation (R3)
- **Example:** `T456`
- **Why separate from `dialog_id`?** PS distinguishes "dialog" (exchange) from "task" (work). After restart, must prove same task continues.
- **Derivation:** Deterministically derived from `dialog_id` (FNV-1a hash)

### `request_id`

- **Purpose:** Uniquely identifies one request within a dialog
- **Used for:** Deduplication (R4)
- **Example:** `R789`
- **Why separate?** A dialog contains multiple requests. Deduplication happens at request granularity.

### Composite Keys

- **Correlation key:** `dialog_id`
- **Deduplication key:** `(dialog_id, request_id)`
- **Task identity:** `task_id` (must match stored value)

---

## 5. Lifecycle State Machine

### Current Frontend Model (Existing Implementation)

The frontend currently implements a **6-state model**:

```
INITIATED → PROCESSING → WAITING_ACK → COMMITTED | RECOVERED | FAILED
```

| State | Meaning | Terminal? |
|---|---|---|
| `INITIATED` | Dialog created, no request processed yet | No |
| `PROCESSING` | At least one request processed, work in progress | No |
| `WAITING_ACK` | All work done, waiting for final confirmation | No |
| `COMMITTED` | Task completed successfully, no crash occurred | Yes |
| `RECOVERED` | Task completed successfully after crash+recovery | Yes |
| `FAILED` | Task could not complete | Yes |

**Current frontend transitions:**
```
INITIATED → PROCESSING → WAITING_ACK → COMMITTED | RECOVERED | FAILED
```

**Important:** This is the **current frontend implementation**. The `WAITING_ACK` state is used by the existing simulation engine. We should not blindly delete it — during frontend review, we will determine whether it is genuinely required by the existing UI/simulation.

---

### Approved Backend Target Model (Phase 1 Architecture)

The approved backend will implement a **5-state model**:

```typescript
type LifecycleState = 
  | 'INITIATED' 
  | 'PROCESSING' 
  | 'COMMITTED' 
  | 'RECOVERED' 
  | 'FAILED';
```

```
INITIATED → PROCESSING → COMMITTED | RECOVERED | FAILED
```

| State | Meaning | Terminal? |
|---|---|---|
| `INITIATED` | Dialog created, no request processed yet | No |
| `PROCESSING` | At least one request processed, work in progress | No |
| `COMMITTED` | Task completed successfully, no crash occurred | Yes |
| `RECOVERED` | Task completed successfully after crash+recovery | Yes |
| `FAILED` | Task could not complete | Yes |

**Valid Transitions:**

```
INITIATED → PROCESSING      (first request processed)
INITIATED → FAILED          (error before any work)

PROCESSING → COMMITTED      (work finished, no restart)
PROCESSING → RECOVERED      (work finished, restart occurred)
PROCESSING → FAILED         (unrecoverable error)

COMMITTED → (terminal)
RECOVERED → (terminal)
FAILED → (terminal)
```

**Invalid Transitions (Rejected by State Machine):**

```
COMMITTED → PROCESSING      (cannot reopen finished dialog)
RECOVERED → PROCESSING      (cannot reopen recovered dialog)
FAILED → PROCESSING         (cannot restart failed dialog)
INITIATED → COMMITTED       (cannot complete work that never started)
```

**Why `WAITING_ACK` is NOT in the backend model:**

The PS-021 requirements do not mandate quiescence detection. The minimal backend needs only:
- Non-terminal states: `INITIATED`, `PROCESSING`
- Terminal states: `COMMITTED`, `RECOVERED`, `FAILED`

The distinction between `PROCESSING` and `WAITING_ACK` adds complexity without satisfying any PS requirement. The backend can transition directly from `PROCESSING` to a terminal state.

**Note:** Any change to this approved backend lifecycle requires an explicit architectural decision.

---

### How Recovery Fits

When adapter restarts:
1. Load non-terminal dialogs from storage (state is `INITIATED` or `PROCESSING`)
2. Dialog resumes in stored state
3. When work eventually completes, transition to `RECOVERED` (not `COMMITTED`)
4. `RECOVERED` state proves task identity and state survived restart

---

## 6. Adapter Architecture

### Approved Design: Two Logical Modules in One Node.js Process

```
Single Node.js Backend Process
├── Adapter A Module (Sender)
├── Adapter B Module (Receiver)
├── Dialog Manager Module (Shared)
└── Storage Module (SQLite)
```

### Why Single Process?

- PS-021 only requires "two mock agent adapters" (not separate OS processes)
- Simpler for hackathon timeline
- Easier demonstration (one process, all logs in one console)
- Sufficient realism (can simulate crash by wiping module state)
- SQLite works out-of-the-box (no locking concerns)

### Adapter Responsibilities

**Adapter A (Sender):**
- Initiate dialogs (`dialog_id`, `task_id` assignment)
- Send requests with `request_id`
- Handle retries (resend with same IDs)
- Persist its state

**Adapter B (Receiver):**
- Receive requests
- Correlate via `dialog_id`
- Deduplicate via `request_id`
- Execute side effects
- Transition dialog state
- Persist state after each operation

**Dialog Manager (Shared):**
- Create/retrieve dialog records
- Enforce lifecycle state machine
- Validate transitions
- Coordinate correlation
- Coordinate deduplication

**Storage Layer:**
- Persist dialogs to SQLite
- Persist requests to SQLite
- Query dialogs (by ID, by state)
- Query requests (by dialog+request ID)
- Recover state on startup

### Symmetric vs. Asymmetric

**Design is asymmetric:** Adapter A = sender, Adapter B = receiver.

This reflects PS-021 scenarios where one adapter initiates and the other responds. Both use the same Dialog Manager and Storage, so core mechanisms (correlation, deduplication, persistence, recovery) are shared.

---

## 7. Approved Backend Technology Stack

| Technology | Purpose | Why Chosen |
|---|---|---|
| **Node.js 20+** | Runtime | Familiarity, frontend already uses Node |
| **TypeScript** | Language | Type safety for schema/state machine, better tooling |
| **Express** | Web framework | Simple, familiar, standard choice |
| **better-sqlite3** | Database driver | Synchronous SQLite, zero-config, durable |
| **SQLite** | Durable storage | File-based, survives restart, realistic |
| **Zod (optional)** | Request validation | Type-safe validation (nice-to-have) |
| **pino (optional)** | Logging | Structured logs (nice-to-have, console.log fine) |
| **Vitest or Jest** | Testing | Scenario testing |

### Why SQLite?

- True ACID persistence (survives real process crash)
- Zero-configuration (single file: `dialogs.db`)
- Synchronous API (easier reasoning about persistence order)
- Realistic (models production persistent storage)
- Demonstration-friendly (can show `.db` file exists)

### Libraries NOT Needed

❌ Prisma (schema is 2 tables, raw SQL is simpler)  
❌ WebSocket libraries (using SSE)  
❌ Redis (no caching needed)  
❌ Docker (local demo)  
❌ Message queue (in-process architecture)

---

## 8. Minimal Dialog-State Schema

### Core Schema (Required)

**Backend will use 5-state model:**

```typescript
interface Dialog {
  dialog_id: string;      // Primary correlation key
  task_id: string;        // Task identity (must survive restart)
  state: LifecycleState;  // Lifecycle state (5 states, NOT 6)
  created_at: string;     // ISO timestamp
  updated_at: string;     // ISO timestamp
}

type LifecycleState = 
  | 'INITIATED' 
  | 'PROCESSING' 
  | 'COMMITTED' 
  | 'RECOVERED' 
  | 'FAILED';
  // Note: WAITING_ACK is NOT included
```

### Requests Table (Required for Deduplication)

```typescript
interface Request {
  dialog_id: string;      // Foreign key to dialog
  request_id: string;     // Request identity
  processed_at: string;   // ISO timestamp
  result: string;         // JSON-serialized result (for duplicate response)
}

// Composite primary key: (dialog_id, request_id)
```

### SQLite Schema

```sql
CREATE TABLE dialogs (
  dialog_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE requests (
  dialog_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (dialog_id, request_id)
);
```

### Fields Deliberately Excluded

These are not in the minimal schema (unless proven necessary during implementation):
- `sequence_no` (not required by PS)
- `attempt` (retry count not required)
- `payload_digest` (content-based dedup not required)
- `protocol` (MCP/A2A distinction is demo metadata, not required)
- `buffered` (reorder buffer is implementation detail, not schema)

---

## 9. Approved Five Scenarios

The five scenarios are **failure experiments** testing different parts of the same dialog-management system.

### Scenario 1: Multiple Dialogs → Correct Correlation

**Primary Focus:** Correlation

**Situation:** Two dialogs (`D1/T1` and `D2/T2`) are active simultaneously. Requests arrive interleaved:
```
D1/T1/R1 → D2/T2/R1 → D1/T1/R2 → D2/T2/R2
```

**Failure Mode:** System mixes requests from different dialogs.

**Expected Result:**
- D1 processes R1, R2 (side effects: 2)
- D2 processes R1, R2 (side effects: 2)
- No cross-contamination
- Both dialogs: `COMMITTED`

**What This Demonstrates:** Correlation via `dialog_id`, state isolation

---

### Scenario 2: Request Lost → Retry

**Primary Focus:** Retry handling when request never reaches receiver

**Situation:**
```
A sends R1 → lost in network (B never receives)
A retries R1 → reaches B
```

**Important:** This is NOT a deduplication test. B never saw the first attempt.

**Expected Result:**
- Retry successfully reaches B
- B processes it (does not reject as duplicate)
- Side effects: 1
- Duplicates detected: 0

**What This Demonstrates:** Retry mechanism works, system distinguishes "never arrived" from "already processed"

---

### Scenario 3: Response Lost → Duplicate Request

**Primary Focus:** Request deduplication and duplicate-side-effect prevention

**Situation:**
```
A sends R1 → B processes (side effect executed, counter = 1)
Response lost → A doesn't know if processed
A retries R1 → B receives retry
```

**Key Distinction:** Request DID reach B. B DID process it. Only response was lost.

**Expected Result:**
- B checks: `(D1, R1)` found in requests table
- B returns stored result
- Side effect NOT re-executed (counter stays 1)
- Duplicates detected: 1

**What This Demonstrates:** R4 (deduplication), duplicate-side-effect rejection, distinction from Scenario 2

---

### Scenario 4: Adapter B Restart → Durable State Recovery

**Primary Focus:** Durable state and recovery of receiving adapter

**Situation:**
```
B processes R1 for D1/T1
State persisted to SQLite
B crashes (RAM wiped)
B restarts
Loads D1/T1 from SQLite
Continues processing
```

**Expected Result:**
- Before crash: `D1/T1/PROCESSING`, R1 processed
- After restart: `D1/T1/PROCESSING`, R1 still marked processed
- Task can continue (not restarted from zero)
- If R1 retried: recognized as duplicate

**What This Demonstrates:** R3 (task identity preserved), durable state, recovery, deduplication survives restart

---

### Scenario 5: Mid-Task Disconnect + Adapter A Restart → Resume

**Primary Focus:** Complete recovery — initiating adapter restarts mid-task

**Situation:**
```
Task T1: Step 1 (R1) → Step 2 (R2) → Step 3 (R3)
A sends R1 → B processes ✓
A sends R2 → network disconnect
A crashes
A restarts → loads D1/T1 from storage
A retries R2 → B may or may not have processed it
  Case 1: B never saw R2 → processes normally
  Case 2: B already processed R2 → duplicate detected
Task continues with R3
```

**The Crucial Point:** System does NOT create new task. Original `task_id` preserved.

**Expected Result:**
- `task_id` before crash == `task_id` after restart
- Dialog state: `RECOVERED` (proves restart occurred)
- Side effects: 3 (not duplicated)
- Task continued (not restarted from zero)

**What This Demonstrates:** R3 (task identity preservation), durable recovery, retry, deduplication, task continuation — all mechanisms working together

---

### How the Five Fit Together

```
Scenario 1 → Can we identify the correct dialog?
             CORRELATION

Scenario 2 → What if the request never arrives?
             RETRY HANDLING

Scenario 3 → What if the request arrived but response didn't?
             DEDUPLICATION

Scenario 4 → What if the receiving adapter crashes?
             DURABLE RECOVERY (RECEIVER)

Scenario 5 → What if the initiating adapter crashes mid-task?
             TASK IDENTITY + RECOVERY + CONTINUATION (SENDER)
```

---

## 10. Frontend Audit Summary (Phase 0 Findings)

### Current Repository Structure

```
Nighthawks/
├── README.md                           (comprehensive design doc, all TBD)
└── Front/
    └── frontend/                       (React + Vite, Tailwind)
        ├── package.json                (name: nighthawks-adapter-a)
        ├── src/
        │   ├── App.jsx
        │   ├── lib/
        │   │   ├── constants.js        (lifecycle states, scenarios, timing)
        │   │   ├── protocol.js         (ID derivation, correlation key, envelopes)
        │   │   ├── useCorrelationEngine.js  (1237 lines - THE ENGINE)
        │   │   ├── narrate.js          (log translation layer)
        │   │   └── format.js           (timestamps, export utilities)
        │   └── components/
        │       ├── PipelineVisualizer.jsx
        │       ├── ScenarioHub.jsx
        │       ├── TaskList.jsx
        │       ├── ActivityFeed.jsx
        │       └── ui/
        └── tests/
            └── conformance.mjs         (headless test harness)
```

### Key Finding: Frontend Contains Full Simulation Engine

The frontend is NOT just a visual UI. It contains a complete in-browser PS-021 simulation engine in `useCorrelationEngine.js` (1237 lines).

**What the frontend engine currently implements:**
- Dialog creation and management
- Three-identifier model (`dialog_id`, `task_id`, `request_id`)
- Six lifecycle states (`INITIATED → PROCESSING → WAITING_ACK → COMMITTED | RECOVERED | FAILED`)
- State machine with transition enforcement
- Correlation (via `dialog_id`)
- Deduplication (via `(dialog_id, sequence_no)`)
- Simulated durable storage (JS Map, survives in-session but not page reload)
- Simulated crash/recovery (`killAdapter`, `coldStartAdapter`)
- Reorder buffer and NACK retransmission
- Five scenario implementations (different from Phase 1 definitions)
- Wire event log and activity feed
- Metrics computation

**Current frontend lifecycle states (6-state model):**
```
INITIATED, PROCESSING, WAITING_ACK, COMMITTED, RECOVERED, FAILED
```

**Approved backend lifecycle states (5-state model):**
```
INITIATED, PROCESSING, COMMITTED, RECOVERED, FAILED
```

(Note: `WAITING_ACK` is in current frontend but NOT in approved backend)

**Frontend scenarios (current):**
1. Normal Transmission (3 packets in order)
2. Out-of-Order Packets (3,1,2 → reorder buffer → 1,2,3)
3. System Crash & Auto-Recovery (sender crashes mid-task)
4. Duplicate Request Guard (same packet sent 4x)
5. Missing Packet Recovery (packets 2+3 lost → NACK → retransmit)

### Frontend vs. Approved Backend Architecture

| Aspect | Current Frontend | Approved Backend |
|---|---|---|
| Lifecycle states | 6 states (includes `WAITING_ACK`) | **5 states (no `WAITING_ACK`)** |
| Identifiers | `dialog_id`, `task_id`, uses `seq` for dedup | `dialog_id`, `task_id`, `request_id` |
| Dedup key | `(dialog_id, sequenceNo)` | `(dialog_id, request_id)` |
| Durable storage | JS Map (in-memory) | SQLite (file-based) |
| Scenarios | 5 scenarios (packet-focused) | 5 scenarios (failure-focused) |
| Reorder buffer | Yes (out-of-order handling) | Not in minimal backend |

**Key architectural differences:** 

1. **Lifecycle:** Frontend has 6 states including `WAITING_ACK`. Backend will use 5 states without `WAITING_ACK`. This is an intentional difference — `WAITING_ACK` adds quiescence detection which is not required by PS-021.

2. **Scenarios:** Frontend scenarios focus on packet sequencing (out-of-order, NACK, reorder buffer). Approved backend scenarios focus on failure modes (request lost, response lost, adapter restart).

**Decision:** Backend will implement the approved 5-state, 5-scenario architecture. Frontend scenarios are valid but different experiments. Both are legitimate PS-021 demonstrations.

**Important:** We should not blindly delete `WAITING_ACK` from the frontend. During frontend review, we will determine whether it is genuinely required by the existing UI/simulation.

---

## 11. Backend ↔ Frontend Boundary

### Backend Owns (Authoritative PS-021 Behavior)

- **Mock Adapters** (Adapter A, Adapter B)
- **Dialog state management** (create, retrieve, update)
- **Lifecycle state machine** (transition enforcement)
- **Correlation** (match `dialog_id` to existing dialog)
- **Deduplication** (check `(dialog_id, request_id)` in requests table)
- **Durable persistence** (SQLite: dialogs + requests tables)
- **Recovery** (reload active dialogs on startup)
- **Scenario execution** (run five experiments, drive adapters)
- **Side effect tracking** (counters, observable behavior)
- **APIs** (REST endpoints for commands, queries)
- **Event stream** (SSE for real-time updates)

### Frontend Owns (Visualization and Interaction)

- **Dashboard layout** (panels, responsive grid)
- **Header** (title, connection status, reset button)
- **Metric bar** (4 headline numbers)
- **Pipeline visualizer** (4-node diagram, animated packet dots)
- **Scenario hub** (5 scenario cards, run buttons, results)
- **Task list** (per-dialog view, lifecycle stepper)
- **Activity feed** (scrolling log stream, filters, export)
- **Narration layer** (translate backend logs to plain English)
- **Presentation utilities** (formatting, colors, icons)
- **Backend integration** (API calls, SSE client)

### Data Flow: Backend → Frontend

The frontend will consume from backend via:

**REST Queries:**
- `GET /api/dialogs` → dialog list
- `GET /api/dialogs/:id` → dialog details
- `GET /api/metrics` → aggregate metrics
- `GET /api/logs` → activity log entries

**REST Commands:**
- `POST /api/requests` → send request manually
- `POST /api/scenarios/:id/run` → run scenario
- `POST /api/adapters/:name/crash` → simulate crash
- `POST /api/adapters/:name/restart` → restart adapter
- `POST /api/reset` → reset all state

**SSE Event Stream:**
- `GET /api/events` → real-time stream
  - Event: `log` (activity log entry)
  - Event: `dialog` (dialog state updated)
  - Event: `wire` (packet event for animation)
  - Event: `scenario-step` (scenario progress)

---

## 12. Current Project Status

```
✅ Phase 0: Repository Audit — COMPLETE
   - Existing frontend understood
   - Simulation engine analyzed
   - Frontend/backend responsibilities identified
   - No PS-021 backend exists yet

✅ Phase 1: Backend Architecture & Design — COMPLETE
   - Technology stack chosen (Node.js, TypeScript, Express, SQLite)
   - Minimal dialog schema defined
   - Three-identifier model finalized
   - Lifecycle state machine adopted (frontend's 6-state model)
   - Adapter architecture designed (single process, two logical modules)
   - Five scenarios defined (failure-focused experiments)
   - Backend/frontend boundary clarified
   - Architecture approved

📄 Persistent Project Context — BEING CREATED (this document)

⏸️ NEXT: Frontend Review/Correction
   - Review frontend scenarios vs. approved scenarios
   - Document any necessary alignment
   - Preserve useful frontend work
   - DO NOT rewrite unless conflicts exist

⏸️ FUTURE: Backend Implementation
   - Create backend/ directory structure
   - Implement SQLite storage layer
   - Implement Dialog Manager
   - Implement Adapter A + Adapter B
   - Implement five scenarios
   - Implement REST API + SSE
   - Write scenario tests
   - Integration with frontend

⏸️ FUTURE: Final Testing and Demo
```

---

## 13. Development Roadmap

### Incremental Backend Development Order

Backend will NOT be built in one giant implementation. Incremental order:

**Phase 2.1: Storage Layer**
- SQLite schema creation
- Storage module (create/read/update dialogs and requests)
- Basic persistence tests

**Phase 2.2: Dialog Manager**
- Dialog creation
- State machine enforcement
- Transition validation
- Correlation logic
- Deduplication logic

**Phase 2.3: Adapters**
- Adapter A module (sender role)
- Adapter B module (receiver role)
- Request/response flow
- Simulated crash/restart

**Phase 2.4: Recovery**
- On-startup reload from SQLite
- Active dialog restoration
- Recovery verification

**Phase 2.5: Scenarios**
- Scenario 1: Multiple Dialogs
- Scenario 2: Request Lost
- Scenario 3: Response Lost
- Scenario 4: Adapter B Restart
- Scenario 5: Adapter A Restart

**Phase 2.6: API Layer**
- Express server setup
- REST endpoints
- SSE event stream
- CORS configuration

**Phase 2.7: Integration**
- Frontend connects to backend
- Replace frontend simulation engine with backend API calls
- Verify visualization works with real backend

**Phase 2.8: Testing**
- Automated scenario tests
- Integration tests
- Demo preparation

---

## 14. Kiro Development Rules

### Permanent Rules for All Sessions

1. **Read this document first** before any implementation work
2. **Read the official PS-021 PDF** before major implementation
3. **Never silently change approved architecture** — document and discuss conflicts
4. **Work phase-by-phase** — complete one phase before starting next
5. **Inspect before modifying** — read existing code before changing it
6. **Do not over-engineer** — this is a hackathon prototype, not production
7. **Preserve useful existing work** — frontend simulation is valuable reference
8. **Test important behavior** — five scenarios must be demonstrable
9. **Do not claim universal exactly-once** — acknowledge crash window limitation
10. **Do not claim final IETF compliance** — experimental schema only
11. **Do not claim complete MCP/A2A interoperability** — mock envelopes only
12. **Do not implement future phases early** — respect incremental development
13. **Stop after each phase** and wait for approval before proceeding
14. **Clearly distinguish** current implementation from planned architecture

### When Starting a New Session

1. Read `KIRO_PROJECT_CONTEXT.md` (this document)
2. Check current project status (section 12)
3. Confirm which phase you are working on
4. Review approved architecture for that phase
5. Inspect current repository state
6. Identify any conflicts between planned vs. actual
7. Document conflicts, don't silently resolve them
8. Proceed with approved plan

### When Architecture Questions Arise

**If unsure about an architectural decision:**
1. Check if this document answers it
2. Check if Phase 1 design document answers it
3. If still unclear, ask the user before implementing
4. Document the decision once made

**If you discover a conflict:**
1. Document what the approved architecture says
2. Document what the current code does
3. Explain the conflict clearly
4. Wait for user decision
5. Do NOT silently change either side

---

## 15. Known Limitations and Non-Claims

### What We ARE Demonstrating

✅ Dialog identity preservation across adapter restart  
✅ Task identity preservation (same `task_id` after restart)  
✅ Lifecycle state preservation (dialog resumes in same state)  
✅ Request deduplication prevents duplicate side effects (when request was processed)  
✅ Valid lifecycle transitions enforced  
✅ Invalid lifecycle transitions rejected  
✅ Five disconnect/retry scenarios covering different failure modes  
✅ Durable state survives process restart  

### What We Are NOT Claiming

❌ Universal exactly-once delivery  
❌ Crash window between side effect and persistence (acknowledged limitation)  
❌ Concurrent duplicate handling (single-threaded processing assumed)  
❌ Real MCP/A2A interoperability (mock envelopes only)  
❌ IETF standard implementation (experimental schema)  
❌ Production readiness (hackathon prototype)  
❌ Distributed consensus (single-node)  
❌ Byzantine fault tolerance  
❌ Authentication/authorization  
❌ Encryption  

### Stated Limitations

1. **Crash window:** If adapter crashes after executing side effect but before saving request record, retry will re-execute side effect
2. **Simulated failures:** Crashes are simulated (memory wipe), not actual process kills (though storage is real)
3. **Single node:** Both adapters in one process
4. **Single-threaded:** No concurrent request handling
5. **Local only:** No network transport, in-process calls
6. **Mock agents:** Both agents are test stubs, not real AI agents

---

## 16. Reference Material

### Source Documents

- **Official PS-021 PDF** (in repository, primary source of truth)
- **README.md** (comprehensive design doc, all sections marked TBD until implemented)
- **Phase 0 Audit Report** (completed, findings preserved in this document)
- **Phase 1 Architecture Document** (completed, decisions preserved in this document)

### Frontend Reference

The existing frontend implementation in `Front/frontend/src/lib/useCorrelationEngine.js` is a valuable reference for:
- Lifecycle state machine implementation
- Correlation logic
- Deduplication logic
- Simulated crash/recovery flow
- Scenario orchestration patterns
- Event logging structure

**Do NOT copy blindly** — backend has different requirements (real persistence, REST API, different scenarios) — but the frontend demonstrates working PS-021 concepts.

### Key Files to Reference

- `src/lib/constants.js` — lifecycle states, transition table, timing constants
- `src/lib/protocol.js` — ID derivation algorithms, correlation key format
- `src/lib/useCorrelationEngine.js` — full simulation engine
- `tests/conformance.mjs` — test harness structure, scenario verification

---

## 17. Important Architectural Points

### Why `dialog_id` and `task_id` Are Separate

The PS distinguishes "dialog" (exchange) from "task" (work). After a restart, we must prove the same task continues, not a new one. Separate identifiers make this explicit.

### Why `request_id` Is Necessary for Deduplication

Without `request_id`, we cannot distinguish:
- "First request in this dialog"
- "Second request in this dialog"
- "Retry of first request"

With `request_id`, deduplication key is `(dialog_id, request_id)`.

### Why SQLite Instead of In-Memory

In-memory (JS Map) does not survive real process restart. SQLite file survives restart, making "durable state" claim honest. Required for R3.

### Why Single Process Instead of Two Processes

PS-021 requires "two mock agent adapters", not "two separate OS processes." Single process is:
- Simpler to implement (no IPC)
- Easier to debug (one console)
- Sufficient for demonstrating recovery (simulate crash by wiping module state)
- More practical for hackathon timeline

### Why Six Lifecycle States in Frontend, Five in Backend

**Frontend** currently implements `INITIATED → PROCESSING → WAITING_ACK → COMMITTED | RECOVERED | FAILED` (6 states). This includes quiescence detection via the `WAITING_ACK` state.

**Approved backend** will implement `INITIATED → PROCESSING → COMMITTED | RECOVERED | FAILED` (5 states). The `WAITING_ACK` state is not included because:
- PS-021 does not require quiescence detection
- Minimal backend needs only processing vs. terminal states
- Simpler state machine with fewer transitions
- Backend can transition directly from `PROCESSING` to terminal states

**During frontend review:** We will determine whether `WAITING_ACK` is genuinely required by the existing UI/simulation. We should not blindly delete it without understanding its role.

**Important:** Any change to the approved backend lifecycle (e.g., adding `WAITING_ACK` back) requires an explicit architectural decision.

### Why Scenarios Differ from Frontend

Frontend scenarios focus on packet-level behavior (out-of-order, reorder buffer, NACK). Approved backend scenarios focus on failure modes (request lost, response lost, adapter restart). Both are valid PS-021 experiments testing different aspects of the system.

---

## 18. Success Criteria

### Demo Must Show

1. **Two mock adapters** functioning (Adapter A, Adapter B)
2. **Dialog correlation** working (multiple concurrent dialogs stay isolated)
3. **Task identity preserved** across adapter restart (same `task_id` after crash)
4. **Request deduplication** preventing duplicate side effects
5. **Lifecycle states** and valid transitions enforced
6. **Durable state** surviving restart (SQLite file persists)
7. **Five scenarios** executing successfully with expected outcomes
8. **Logs/metrics** showing correlation, deduplication, recovery events

### Code Must Demonstrate

- Dialog schema matching approved design
- State machine rejecting invalid transitions
- Deduplication keyed on `(dialog_id, request_id)`
- SQLite persistence of dialogs + requests
- Recovery loading non-terminal dialogs on startup
- Scenario orchestration driving adapters through failure modes
- REST API + SSE for frontend integration

### Documentation Must Include

- Clear statement this is experimental prototype
- No claim of IETF standard compliance
- No claim of universal exactly-once delivery
- No claim of complete MCP/A2A interoperability
- Acknowledgment of crash window limitation
- Pseudocode snippet (as required by PS)
- Requirements traceability (R1-R8 mapped to implementation)

---

## End of Project Context Document

**This document preserves all Phase 0 and Phase 1 decisions. Future sessions should read this first before beginning any work.**

**Current Status:** Phase 0 and Phase 1 complete. Backend implementation has not started. Next task is frontend review/correction if needed, then incremental backend development.

**Last Updated:** After Phase 1 approval

---
