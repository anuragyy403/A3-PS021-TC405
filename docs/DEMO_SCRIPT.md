# Nighthawks PS-021 — Demo Script (7–8 minutes)

The story to make visible: **before failure → failure → retry / restart → correlation /
recovery → correct continuation without a duplicate side effect.**

Every quoted UI string below was seen live in the dry run of 2026-10-09 (launcher,
pace 900 ms) and is asserted by `e2e/tests/*.spec.js` or `e2e/demo/flow.js`. If the
screen ever disagrees with this script, trust the screen and fix the script.

---

## 1. Setup checklist

### T-30 min
- [ ] `node -v` → v20 or newer (verified on v24.14.1). `npm install` already run in
      `backend/`, `Front/frontend/`, `e2e/`.
- [ ] Close every other dev server. Ports **3001** and **5173** must be free — the launcher
      refuses to start otherwise and names the process holding the port.
- [ ] Backup ready: `e2e/demo-output/nighthawks-demo-*.webm` plays (re-record with
      `cd e2e && npm run demo:record`), and `docs/assets/screenshots/*.png` are there.
- [ ] Wi-Fi-off test: with the network off the page still loads at once (web fonts are
      optional, system fonts take over).
- [ ] Decide whether you will do the optional step 7 (real process kill). If yes, use the
      **two-terminal** start below from the beginning.

### T-5 min
Start (fresh demo database `.demo/demo.db`, scenario pace 900 ms per step):

| Without step 7 | With step 7 (real process kill) |
|---|---|
| Terminal 1: `node scripts/demo.mjs` | Terminal 1: `node scripts/demo.mjs --backend-only`<br>Terminal 2: `node scripts/demo.mjs --frontend-only` |

Then:
- [ ] Trace terminal beside the browser: `node scripts/trace.mjs` (large font, dark theme).
- [ ] Browser on `http://localhost:5173`, zoom 90–100 %, full screen; the tab title reads
      "Nighthawks · PS-021 Dialog Correlation & Recovery (experimental)".
- [ ] You see "Live backend", "All connected", "4 of 4 components online", five cards
      with "Not run yet", and "No tasks yet". If not: header **Start over**.
- [ ] Stop at the end with Ctrl+C in each launcher terminal ("[demo] stopped; port(s) … free.").

---

## 2. Talk track

Times are what to budget *with* talking. Machine time measured in the dry run is in
brackets — everything is near-instant except the scenario runs.

### 0 · Framing — 0:00–0:45
Say: *"When two agents talk over an unreliable link, a lost request, a lost reply or a
restart can make one side do the same work twice, or lose which task it was on. We give
every exchange an explicit dialog_id, task_id and sequence number, keep both sides'
records in a SQLite file, and recognise a repeat by (dialog_id, seq)."*
Non-claims, once, up front: **experimental prototype** — two mock adapters, not MCP/A2A,
not an IETF standard, **not exactly-once delivery**.
Point at: the pipeline (Sender Agent → Network Channel → Receiver Agent, Saved State),
and the trace terminal.

### 1 · Start a task — 0:45–1:15  [~1 s]
Click path: **task_id** field → type `order-1001` → **New task**.
Audience sees:
- result line `new task order-1001 · dlg-… · INITIATED`
- "Selected:" pill with the dialog_id; task row "Not started yet", "Created, waiting for the first request"
- trace: `[A] startDialog task_id=order-1001 → dialog_id=dlg-… INITIATED`

Say: dialog_id = this conversation; task_id = the unit of work; both are stored now.

### 2 · Normal request — 1:15–1:40  [~1 s]
Click: **No fault** → **Send seq 1**.
Sees: `seq 1 · processed · work done · reply received · task PROCESSING`; row "In progress",
"1 work item completed so far". Trace: `[B] (dlg-…,1) new → processed (processed_count=1); INITIATED → PROCESSING`.

### 3 · Request lost → retry — 1:40–2:20  [~2 s]
Click: **Lose the request** → **Send seq 2**.
Sees: `seq 2 · request lost · B never saw it · retry it · task PROCESSING`; hover the task's
second square: "Packet 2: sent, not processed yet". Trace: `[net] request for seq 2 LOST — B never saw it`.
Click: **Retry seq 2** (retry defaults to the unanswered seq).
Sees: `retry of seq 2 · processed · work done · reply received · task PROCESSING`;
"2 work items completed so far". Say: same ids, same stored payload — B had never seen it,
so it does the work once.

### 4 · Reply lost → retry = duplicate — 2:20–3:10  [~2 s]
Click: **Lose the reply** → **Send seq 3**.
Sees: `seq 3 · reply lost · B processed it · retry it to get the answer · task PROCESSING`.
Trace: `[net] reply for seq 3 LOST — B already did the work (B status ok)`.
Say: *"The dangerous case: the work is done, but A does not know."*
Click: **Retry seq 3**.
Sees: `retry of seq 3 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING`;
row "3 work items completed so far", "1 duplicate blocked since server start".
Trace: `[B] (dlg-…,3) already processed → DUPLICATE, work NOT repeated, stored answer returned`.
Note: the "Happening right now" banner already shows the *next* event ("Packet 3
confirmed") — point at the result line and the task row instead.

### 5 · Correlation — Scenario 1 card — 3:10–3:55  [run 2.7 s]
Click: card **1 · Multiple Dialogs + Retry → Correct Correlation** → **Run demo**.
Sees: "Running...", the "Step by step" panel, then "Passed in 2.7s" and
"Demo 1 finished: all 9 checks passed in 2.7s."; two new tasks: one "Completed" (D2),
one "Not started yet" (D1). Say: the retry of D2's lost request landed on D2/T2 only;
D1 was untouched — and is deliberately left open (it comes back in step 6).
Your `order-1001` stays selected.

### 6 · Restart mid-task — 3:55–5:15  [~6 s]
Click: **Lose the reply** → **Send seq 4**.
Sees: `seq 4 · reply lost · B processed it · retry it to get the answer · task PROCESSING`.
Click: **Restart Adapter A**.
Sees: `whole backend process restarted from the SQLite file (Adapter A requested) · 2 unfinished tasks reloaded`
and the box **"Reloaded after the last restart"**:
`dlg-… · order-1001 · PROCESSING · next_seq 5 · no answer yet: [4]` (plus Scenario 1's D1:
`· INITIATED · next_seq 1 · no answer yet: []`).
Trace: `[rt] PROCESS RESTART (target A) — both adapters rebuilt from the SQLite file`,
`[A] recovered dlg-… task_id=order-1001 state=PROCESSING next_seq=5 pending=[4]`.
Say: both adapters share one SQLite file, so "restart A" and "restart B" both rebuild
everything from that file; next_seq and the unanswered seq come from durable state.
Click: **Retry seq 4** → `retry of seq 4 · duplicate blocked · work NOT repeated · stored answer returned · task PROCESSING`.
Click: **No fault** → **Send seq 5** → `seq 5 · processed · work done · reply received · task PROCESSING`.
Click: **Complete task** → `task completed after a restart → RECOVERED`.
Row: "Recovered", "Finished after a restart — 5 work items, none repeated", same dialog_id.

### 7 · OPTIONAL — kill the real backend process — 5:15–6:15  [~35 s incl. restart]
(Only with the two-terminal start.) New task `order-1002` → **No fault** → **Send seq 1**
(`seq 1 · processed · …`). Then in the **backend terminal press Ctrl+C**
("[demo] stopped; port(s) 3001 free.").
Sees: "Live backend · unreachable", header "Disconnected", hint "The backend is not
reachable — controls are paused until it is back.", the task list still showing what it
knew. (The dashboard terminal prints Vite "http proxy error … ECONNREFUSED" lines — expected.)
Restart: `node scripts/demo.mjs --backend-only --keep-db` ("reusing database …").
Sees within ~1 s of the backend being up: "Live backend", "All connected", all tasks still
listed. Trace: `backend reachable again`, `new event log (epoch …)`,
`[A] recovered … task_id=order-1002 state=PROCESSING next_seq=2 pending=[]`.
Click: **Send seq 2** → **Complete task** → `task completed after a restart → RECOVERED`.
Say: this is a real OS-process crash and restart, not a simulated one.

### 8 · Run all five — 6:15–6:50  [~17 s at pace 900]
Click: **Run all five**.
Sees: each card "Passed in …", header pill **"5 of 5 passed"**, last strip
"Demo 5 finished: all 13 checks passed in 4.5s.". The Tasks / Recovery cards now include
the tasks from the earlier steps (e.g. "2 not started", "… restored tasks still open" —
those are Scenario 1's D1 tasks, open by design).

### 9 · Close — 6:50–7:45
- Pseudocode: [`docs/PSEUDOCODE.md`](PSEUDOCODE.md) — point at the order in
  `handleRequest` (correlate → dedup → terminal check → execute → record → transition) and
  the marked **crash window**.
- Test results: [`docs/TEST_RESULTS.md`](TEST_RESULTS.md) — 265 backend tests, frontend
  unit tests, 16 browser E2E tests (3 runs in a row), mutation checks.
- Limitations, said plainly: crash window between the work and its record (so **not
  exactly-once**); one process and one shared SQLite file (restart A = restart B); per-task
  duplicate counts and the activity log live in memory; not MCP/A2A; not an IETF standard.

---

## 3. Q&A preparation

| Question | Short, honest answer |
|---|---|
| Is this exactly-once? | No. A repeat of a request that was **recorded as processed** is never executed again. If B crashed after doing the work but before writing the record, a retry would run it again. That is the crash window in `docs/PSEUDOCODE.md`. |
| What if B crashes between the side effect and the record? | The work may run twice on retry. Closing that needs the side effect and the record in one transaction, or idempotent side effects — listed as future work. |
| Why is "Restart A" the same as "Restart B"? | Both adapters run in one Node process over one SQLite handle; a restart closes the handle, drops all in-memory objects and rebuilds both from the file. The UI and API say "whole backend process". |
| Why does Scenario 1 leave a task open? | The scenario's point is that the retry is correlated to D2 only; D1 never gets a request, so it stays "Not started yet" (INITIATED). Later restarts reload it, so it shows as "restored still open". |
| Is this MCP or A2A? | No. Two mock adapters with an experimental schema; MCP and A2A are the motivation in the problem statement, not something we implement or interoperate with. |
| What does interoperability mean here? | Both adapters are ours, same codebase, same schema. We do not claim interoperability between independently built adapters — that is an open question for the mentors. |
| How do you know the seq after a restart? | Adapter A's send log is in SQLite: next_seq = max logged seq + 1; unanswered seqs are the rows still PENDING. Both are shown in the "Reloaded after the last restart" box and the trace. |
| What survives a restart? | The three SQLite tables: dialogs, Adapter A's send log, Adapter B's processed records. Not: `side_effects_since_boot` (reset by every restart), duplicate counts and the event log (lost when the process exits). |
| Why a retry with the same seq and not a new request? | The (dialog_id, seq) pair *is* the dedup key; a new seq would be new work. Retries replay the stored payload, so they cannot differ. |
| What stops a task from retrying forever? | A retry budget: after 5 unanswered attempts of one request the dialog goes FAILED. A finished task accepts no new work; retrying an already-answered seq is still allowed and returns the stored answer. |

---

## 4. Fallback plan

| If… | Do this |
|---|---|
| the live demo breaks | (a) Play the backup video `e2e/demo-output/nighthawks-demo-*.webm` (steps 1–6 and 8 with captions, ~68 s; regenerate with `cd e2e && npm run demo:record`). |
| the video does not play | (b) `cd e2e && npm run e2e:headed` — the full browser suite (16 tests) runs visibly in Edge on its own ports (3101/5199). |
| the browser is the problem | (c) Backend only: `node scripts/demo.mjs --backend-only` + `node scripts/trace.mjs`, and drive it with curl (Git Bash; paste the dialog_id): |
| nothing runs at all | (d) `cd backend && npx vitest run tests/scenarios.test.ts --reporter=verbose` — the five scenarios at adapter level, with test names that tell the story; plus the screenshots in `docs/assets/screenshots/`. |

curl sequence for (c):

```bash
curl -s -X POST localhost:3001/api/dialogs -H 'content-type: application/json' -d '{"task_id":"order-1001"}'
```

```bash
curl -s -X POST localhost:3001/api/dialogs/<dialog_id>/requests -H 'content-type: application/json' -d '{"payload":{"op":"charge"},"fault":"drop_response"}'
```

```bash
curl -s -X POST localhost:3001/api/dialogs/<dialog_id>/requests/1/retry -H 'content-type: application/json' -d '{}'
```

```bash
curl -s -X POST localhost:3001/api/adapters/A/restart -H 'content-type: application/json' -d '{}'
```

```bash
curl -s -X POST localhost:3001/api/dialogs/<dialog_id>/complete -H 'content-type: application/json' -d '{}'
```
