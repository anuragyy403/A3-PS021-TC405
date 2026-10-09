# Nighthawks PS-021 — Pseudocode (one page)

Condensed from the real code paths; each block names its source (file · function).
Every repository write calls `persistToDisk()` before returning, so "persist" below
means "written to the SQLite file". Tables: `dialogs`, `send_log` = `outbound_requests`
(Adapter A), `processed` = `requests` (Adapter B). Experimental prototype — not exactly-once.

```text
# ---------- Adapter A: the initiating side ---------------------------------
# backend/src/adapters/AdapterA.ts · startDialog
startDialog(task_id):
    dialog_id = "dlg-<time>-<random>"
    dialogs.insert(dialog_id, task_id, INITIATED)                  # persist

# AdapterA.ts · sendRequest
sendRequest(dialog_id, payload):
    if dialogs.get(dialog_id).state is terminal: throw DIALOG_TERMINAL
    seq = send_log.max_seq(dialog_id) + 1                          # next seq from durable state
    send_log.insert(dialog_id, seq, payload, PENDING, attempts=1)  # persist BEFORE sending
    return deliver(dialog_id, task_id, seq, payload)

# AdapterA.ts · retryRequest   (allowed on finished dialogs: idempotent replay)
retryRequest(dialog_id, seq):
    row = send_log.get(dialog_id, seq) or throw REQUEST_NOT_FOUND
    send_log.attempts += 1                                         # persist
    return deliver(dialog_id, task_id, seq, row.payload)           # SAME ids, SAME payload

# AdapterA.ts · deliver + failIfRetryBudgetExhausted
deliver(req):
    try: response = transport.send(req)                            # may drop request or reply
    on lost message:
        if row still PENDING and row.attempts >= maxAttempts (5): transition(dialog, FAILED)
        rethrow                                                    # API reports "request/reply lost"
    if response.status in (ok, duplicate): send_log.mark(req.seq, ACKED)   # persist
    return response

# AdapterA.ts · completeDialog
completeDialog(dialog_id):
    if send_log.pending(dialog_id) not empty: throw PENDING_REQUESTS(pending_seqs)
    transition(dialog, RECOVERED if dialog.restored else COMMITTED)   # INITIATED → error: INVALID_TRANSITION

# ---------- Adapter B: the receiving side ----------------------------------
# backend/src/adapters/AdapterB.ts · handleRequest      (order matters)
handleRequest(req):
    dialog = correlate(req.dialog_id, req.task_id)    # DialogManager.correlate: DIALOG_NOT_FOUND / TASK_MISMATCH
    record = processed.get(req.dialog_id, req.seq)    # dedup key = (dialog_id, seq)
    if record exists: return duplicate(record.result) # stored answer, work NOT re-run (even if finished)
    if dialog.state is terminal: return error(DIALOG_TERMINAL)
    result = run_side_effect(req.payload)             # ── CRASH WINDOW opens: work done, not yet recorded
    processed.insert(req.dialog_id, req.seq, result)  # persist ── CRASH WINDOW closes
    if dialog.state == INITIATED: transition(dialog, PROCESSING)       # persist
    return ok(result)
    # A crash inside the window means the retry runs the work again: duplicate-side-effect
    # prevention holds only once the processed record is durable — NOT exactly-once.

# ---------- Restart and recovery --------------------------------------------
# backend/src/runtime/SimulationRuntime.ts · doRestart (POST /api/adapters/A|B/restart)
restart(target):                                      # target A and B behave the same
    close the database handle; drop every in-memory object   # both adapters share one store
    reopen the SQLite file; rebuild Adapter A, Adapter B, transport
    return recover()

# AdapterA.ts · recover      (also run at every server start: SimulationRuntime.create)
recover():
    for dialog in dialogs where state in (INITIATED, PROCESSING):
        dialog.restored = true                                     # persist
        report(dialog_id, task_id, state,
               next_seq     = send_log.max_seq(dialog_id) + 1,     # from durable state
               pending_seqs = send_log.pending(dialog_id))         # retried by the caller, same seq
```

What survives any restart: the three tables in the SQLite file (`dialogs`,
`outbound_requests`, `requests`). In memory only: `side_effects_since_boot` (reset by every
restart), `duplicates_since_boot` and the activity event log (both survive the in-process
"Restart Adapter" rebuild, lost when the OS process exits or on reset).
