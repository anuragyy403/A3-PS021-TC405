/**
 * User-facing text for backend errors and outcomes (Phase 7b).  Pure functions.
 *
 *   errorMessage(error)      ApiClientError (or anything thrown) → one short sentence
 *   outcomeMessage(result)   SendResult (docs/API_DESIGN.md §4) → one result line
 *   restartMessage(result)   RestartResult → one line
 *   dialogMessage(kind, d)   create / complete / abort → one line
 */

const seqList = (seqs) => (seqs.length === 1 ? `seq ${seqs[0]}` : `seq ${seqs.slice(0, -1).join(', ')} and ${seqs[seqs.length - 1]}`);

function firstIssue(details) {
  if (!Array.isArray(details) || details.length === 0) return null;
  const issue = details[0];
  const where = Array.isArray(issue?.path) && issue.path.length ? `${issue.path.join('.')}: ` : '';
  return issue?.message ? `${where}${issue.message}` : null;
}

export function errorMessage(error) {
  const code = error?.code;
  switch (code) {
    case 'NETWORK':
      return 'The backend is not reachable — is it running (backend/: npm run dev)?';
    case 'VALIDATION_ERROR': {
      const issue = firstIssue(error.details);
      return `The backend rejected the input${issue ? ` — ${issue}` : ''}.`;
    }
    case 'DIALOG_NOT_FOUND':
      return 'That task does not exist any more (the backend may have been reset).';
    case 'REQUEST_NOT_FOUND':
      return 'That packet number was never sent for this task.';
    case 'DIALOG_TERMINAL':
      return 'This task is already finished — it accepts no new work. Retrying a packet it already sent is still allowed.';
    case 'PENDING_REQUESTS': {
      const pending = Array.isArray(error.details?.pending_seqs) ? error.details.pending_seqs : [];
      return pending.length
        ? `Cannot complete yet — ${seqList(pending)} ${pending.length === 1 ? 'has' : 'have'} no answer. Retry ${seqList(pending)} first.`
        : 'Cannot complete yet — some requests have no answer. Retry them first.';
    }
    case 'INVALID_TRANSITION':
      return /INITIATED/.test(error.message ?? '')
        ? 'Nothing to complete yet — send at least one request before completing this task.'
        : 'That step is not allowed in the task\'s current state.';
    case 'RUNTIME_BUSY':
      return 'The backend is busy (a demo or another action is running) — try again in a moment.';
    case 'RESET_DISABLED':
      return 'Reset is disabled on this backend (ALLOW_RESET=false).';
    case 'PAYLOAD_TOO_LARGE':
      return 'The request is too large (the backend accepts up to 100 kB).';
    case 'INTERNAL_SERVER_ERROR':
      return 'The backend hit an unexpected error — check the server log.';
    default:
      return `Unexpected error${code ? ` (${code})` : ''}: ${error?.message ?? String(error)}`;
  }
}

const REJECTION = {
  DIALOG_TERMINAL: 'task already finished, new work refused',
  TASK_MISMATCH: 'it names a different task',
  DIALOG_NOT_FOUND: 'unknown task',
  INTERNAL: 'internal error',
};

/** One line for a send/retry SendResult: seq + delivery + outcome + state. */
export function outcomeMessage(r) {
  const head = r.kind === 'retry' ? `retry of seq ${r.seq}` : `seq ${r.seq}`;
  let body;
  if (r.delivery === 'request_dropped') {
    body = 'request lost · B never saw it · retry it';
  } else if (r.delivery === 'response_dropped') {
    body = 'reply lost · B processed it · retry it to get the answer';
  } else if (r.outcome === 'duplicate') {
    body = 'duplicate blocked · work NOT repeated · stored answer returned';
  } else if (r.outcome === 'rejected') {
    body = `refused by B · ${REJECTION[r.error_code] ?? r.error_code ?? 'rejected'} · no work done`;
  } else {
    body = `processed · work done · reply received`;
  }
  const failed = r.dialog_failed ? ' · retry limit reached → task FAILED' : '';
  return `${head} · ${body}${failed} · task ${r.dialog?.state ?? '?'}`;
}

export function restartMessage(r) {
  const n = r.recovered?.length ?? 0;
  return `whole backend process restarted from the SQLite file (Adapter ${r.target} requested) · ${n} unfinished task${n === 1 ? '' : 's'} reloaded`;
}

export function dialogMessage(kind, d) {
  if (kind === 'create') return `new task ${d.task_id} · ${d.dialog_id} · ${d.state}`;
  if (kind === 'complete') {
    return d.state === 'RECOVERED' ? 'task completed after a restart → RECOVERED' : 'task completed → COMMITTED';
  }
  if (kind === 'abort') return 'task aborted by the operator → FAILED';
  return `${kind} · ${d?.state ?? ''}`;
}
