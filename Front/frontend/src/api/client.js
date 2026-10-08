/**
 * Minimal fetch client for the Nighthawks backend API (docs/API_DESIGN.md §2).
 *
 * JSON in, JSON out.  Any non-2xx answer is thrown as an ApiClientError carrying
 * the backend's ApiError body { error, message, status, details }.  A request
 * that never got an HTTP answer (server down, proxy refused) is thrown with
 * code 'NETWORK' and status 0.
 *
 * Simulated message drops are NOT errors: send/retry return 200 SendResults
 * whose `delivery` / `outcome` fields say what happened (§4).
 */

export class ApiClientError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Base URL; empty means same origin (the Vite dev proxy). Overridable for scripts. */
let baseUrl = '';

export function setBaseUrl(url) {
  baseUrl = String(url ?? '').replace(/\/+$/, '');
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiClientError({ status: 0, code: 'NETWORK', message: error?.message || 'Backend unreachable' });
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    throw new ApiClientError({
      status: res.status,
      code: payload?.error ?? (res.status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'HTTP_ERROR'),
      message: payload?.message ?? `HTTP ${res.status}`,
      details: payload?.details,
    });
  }
  if (payload === null) {
    throw new ApiClientError({ status: res.status, code: 'BAD_RESPONSE', message: 'Response was not JSON' });
  }
  return payload;
}

const enc = encodeURIComponent;

// ---- reads (7a) -------------------------------------------------------------
export const getHealth = () => request('GET', '/health');
export const getState = () => request('GET', '/api/state');
export const listDialogs = ({ state, limit } = {}) => {
  const q = new URLSearchParams();
  if (state) q.set('state', state);
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  return request('GET', `/api/dialogs${qs ? `?${qs}` : ''}`);
};
export const getDialog = (dialogId) => request('GET', `/api/dialogs/${enc(dialogId)}`);
export const getEvents = (since = 0, limit = 200) => request('GET', `/api/events?since=${since}&limit=${limit}`);
export const listScenarios = () => request('GET', '/api/scenarios');

// ---- scenario + reset (7a) ---------------------------------------------------
export const runScenario = (id, { step_delay_ms, variant } = {}) =>
  request('POST', `/api/scenarios/${enc(id)}/run`, {
    ...(step_delay_ms !== undefined ? { step_delay_ms } : {}),
    ...(variant !== undefined ? { variant } : {}),
  });
export const resetRuntime = () => request('POST', '/api/reset', { confirm: 'RESET' });

// ---- manual controls (wired in 7b) -------------------------------------------
export const createDialog = (taskId) => request('POST', '/api/dialogs', { task_id: taskId });
export const sendRequest = (dialogId, payload = null, fault) =>
  request('POST', `/api/dialogs/${enc(dialogId)}/requests`, { payload, ...(fault ? { fault } : {}) });
export const retryRequest = (dialogId, seq, fault) =>
  request('POST', `/api/dialogs/${enc(dialogId)}/requests/${enc(seq)}/retry`, fault ? { fault } : {});
export const completeDialog = (dialogId) => request('POST', `/api/dialogs/${enc(dialogId)}/complete`, {});
export const failDialog = (dialogId, reason) => request('POST', `/api/dialogs/${enc(dialogId)}/fail`, { reason });
export const restartAdapter = (adapter) => request('POST', `/api/adapters/${enc(adapter)}/restart`, {});
