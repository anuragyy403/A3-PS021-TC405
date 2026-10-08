/**
 * ObservedTransport — the in-process Transport, instrumented for the API.
 *
 * Delivery semantics are exactly those of Transport (it only calls super).
 * What it adds:
 *
 *   1. Events (docs/API_DESIGN.md §6.4).  Adapter B's handler is wrapped in
 *      registerRequestHandler, so B's answer is seen even when the response is
 *      then dropped:  request_processed / duplicate_suppressed /
 *      request_rejected, and B's INITIATED → PROCESSING state_transition.
 *      sendRequest emits request_dropped / response_dropped / response_delivered.
 *
 *   2. Per-call fault injection (§3).  withFault() arms at most one fault for
 *      exactly one call and ALWAYS clears the transport's flags afterwards,
 *      even if the call throws before reaching the transport, so a fault can
 *      never leak into the next call.
 *
 *   3. Per-call observation (lastCall) so the runtime can report which side
 *      a drop happened on without parsing error messages.
 */

import { Transport, MessageDroppedError } from '../adapters/Transport.js';
import type { RequestHandler } from '../adapters/Transport.js';
import type { AdapterRequest, AdapterResponse } from '../adapters/types.js';
import { isTerminal } from '../types/index.js';
import type { LifecycleState } from '../types/index.js';
import type { ApiEvent, NewEvent } from './EventLog.js';

export type Fault = 'drop_request' | 'drop_response';

export type Delivery = 'delivered' | 'request_dropped' | 'response_dropped';

/** Callbacks into the runtime; evaluated lazily so they follow restarts. */
export interface TransportObserver {
  emit(event: NewEvent): ApiEvent;
  dialogState(dialogId: string): LifecycleState | null;
  processedCount(dialogId: string): number;
  sideEffectsSinceBoot(dialogId: string): number;
}

/** What the transport saw during the most recent withFault() call. */
export interface CallObservation {
  delivery:           Delivery | null;          // null if the transport was never reached
  bResponse:          AdapterResponse | null;   // B's answer, even if then dropped
  stateAfterB:        LifecycleState | null;    // dialog state right after B handled it
}

function emptyObservation(): CallObservation {
  return { delivery: null, bResponse: null, stateAfterB: null };
}

export class ObservedTransport extends Transport {
  private readonly observer: TransportObserver;
  private observation: CallObservation = emptyObservation();

  constructor(observer: TransportObserver) {
    super();
    this.observer = observer;
  }

  /** Observation of the most recent call (reset at the start of each withFault). */
  get lastCall(): CallObservation {
    return this.observation;
  }

  /**
   * Run `fn` with at most one fault armed.  The flags are cleared in `finally`
   * whatever happens, so an unconsumed fault cannot affect the next call.
   */
  async withFault<T>(fault: Fault | undefined, fn: () => Promise<T>): Promise<T> {
    this.observation = emptyObservation();
    this.clearFailureFlags();
    if (fault === 'drop_request')  this.dropNextRequestMessage();
    if (fault === 'drop_response') this.dropNextResponseMessage();
    try {
      return await fn();
    } finally {
      this.clearFailureFlags();
    }
  }

  override registerRequestHandler(handler: RequestHandler): void {
    super.registerRequestHandler(async (request: AdapterRequest) => {
      const before   = this.observer.dialogState(request.dialog_id);
      const response = await handler(request);
      const after    = this.observer.dialogState(request.dialog_id);

      this.observation.bResponse   = response;
      this.observation.stateAfterB = after;
      this.emitHandled(request, response);

      if (before !== null && after !== null && before !== after) {
        this.observer.emit({
          type: 'state_transition', actor: 'B',
          dialog_id: request.dialog_id, task_id: request.task_id, seq: request.seq,
          outcome: after,
          details: { from: before, to: after, reason: 'first request processed' },
        });
      }
      return response;
    });
  }

  override async sendRequest(request: AdapterRequest): Promise<AdapterResponse> {
    const ids = { dialog_id: request.dialog_id, task_id: request.task_id, seq: request.seq };
    this.observation = emptyObservation();  // one observation per transport call
    try {
      const response = await super.sendRequest(request);
      this.observation.delivery = 'delivered';
      this.observer.emit({
        type: 'response_delivered', actor: 'transport', ...ids,
        outcome: response.status, details: { status: response.status },
      });
      return response;
    } catch (error) {
      if (error instanceof MessageDroppedError) {
        // B's handler ran ⇔ the request got through and the response was dropped.
        const handled = this.observation.bResponse;
        if (handled === null) {
          this.observation.delivery = 'request_dropped';
          this.observer.emit({
            type: 'request_dropped', actor: 'transport', ...ids,
            details: { fault: 'drop_request' },
          });
        } else {
          this.observation.delivery = 'response_dropped';
          this.observer.emit({
            type: 'response_dropped', actor: 'transport', ...ids,
            details: { fault: 'drop_response', b_status: handled.status },
          });
        }
      }
      throw error;
    }
  }

  private emitHandled(request: AdapterRequest, response: AdapterResponse): void {
    const ids = { dialog_id: request.dialog_id, task_id: request.task_id, seq: request.seq };

    if (response.status === 'ok') {
      this.observer.emit({
        type: 'request_processed', actor: 'B', ...ids, outcome: 'ok',
        details: {
          processed_count:         this.observer.processedCount(request.dialog_id),
          side_effects_since_boot: this.observer.sideEffectsSinceBoot(request.dialog_id),
        },
      });
    } else if (response.status === 'duplicate') {
      const state = this.observer.dialogState(request.dialog_id);
      this.observer.emit({
        type: 'duplicate_suppressed', actor: 'B', ...ids, outcome: 'duplicate',
        details: { terminal: state !== null && isTerminal(state) },
      });
    } else {
      this.observer.emit({
        type: 'request_rejected', actor: 'B', ...ids, outcome: 'rejected',
        details: { error_code: response.error_code ?? 'INTERNAL', error: response.error ?? null },
      });
    }
  }
}
