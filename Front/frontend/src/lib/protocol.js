/**
 * Wire-format helpers. Adapter A speaks Anthropic MCP (JSON-RPC 2.0) while the
 * peer adapter speaks Google A2A; every dialog frame is wrapped into one of the
 * two envelopes before it crosses the bridge.
 */

/** Deterministic task identity so a rehydrated dialog keeps its correlation id. */
export function deriveTaskId(dialogId, salt = 0x811c9dc5) {
  let hash = salt >>> 0;
  for (let i = 0; i < dialogId.length; i += 1) {
    hash ^= dialogId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `task-${hash.toString(16).padStart(8, '0').slice(0, 8)}`;
}

/** Correlation key used for idempotency: dialog + sequence + attempt. */
export function correlationKey(dialogId, sequenceNo, attempt = 1) {
  return `${dialogId}#${String(sequenceNo).padStart(4, '0')}@${attempt}`;
}

/** FNV-1a over a serialised payload, used to prove replay equality in Scenario 4. */
export function payloadDigest(payload) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sha1:${hash.toString(16).padStart(8, '0')}${json.length.toString(16).padStart(4, '0')}`;
}

/** Anthropic MCP envelope: JSON-RPC 2.0 tools/call. */
export function wrapMcp({ dialogId, sequenceNo, payload, txId, attempt }) {
  return {
    jsonrpc: '2.0',
    id: txId,
    method: 'tools/call',
    params: {
      name: 'correlation/advance',
      arguments: {
        dialog_id: dialogId,
        sequence_no: sequenceNo,
        attempt,
        correlation_key: correlationKey(dialogId, sequenceNo, attempt),
        payload,
      },
    },
  };
}

/** Google A2A envelope: task snapshot plus a message with a data part. */
export function wrapA2a({ dialogId, sequenceNo, payload, txId, attempt, taskId, state }) {
  return {
    task: {
      id: taskId,
      contextId: dialogId,
      status: { state, timestamp: new Date().toISOString() },
    },
    message: {
      role: 'agent',
      messageId: txId,
      taskId,
      kind: 'data',
      metadata: {
        dialog_id: dialogId,
        sequence_no: sequenceNo,
        attempt,
        correlation_key: correlationKey(dialogId, sequenceNo, attempt),
      },
      parts: [{ kind: 'data', data: payload }],
    },
  };
}

/** Dispatch a payload into the envelope matching the selected protocol. */
export function buildEnvelope(protocol, context) {
  return protocol === 'A2A' ? wrapA2a(context) : wrapMcp(context);
}