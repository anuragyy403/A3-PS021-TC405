/**
 * Transport abstraction for PS-021.
 *
 * Provides an in-process message delivery mechanism between Adapter A and
 * Adapter B with controlled failure simulation for testing disconnect/retry
 * scenarios.
 *
 * Failure modes:
 *   - request delivered normally
 *   - request dropped (never reaches Adapter B)
 *   - response dropped (request processed, but response lost)
 *
 * The transport does NOT contain dialog business rules.
 * It is purely a delivery mechanism with deterministic failure injection.
 */

import type { AdapterRequest, AdapterResponse } from './types.js';

/**
 * Handler that processes an incoming request.
 * Adapter B registers this handler with the transport.
 */
export type RequestHandler = (request: AdapterRequest) => Promise<AdapterResponse>;

/**
 * Exception thrown when a message is intentionally dropped.
 */
export class MessageDroppedError extends Error {
  constructor(messageType: 'request' | 'response') {
    super(`${messageType} was dropped (simulated failure)`);
    this.name = 'MessageDroppedError';
  }
}

/**
 * In-process transport for mock adapters with failure simulation.
 *
 * Delivers messages synchronously (no actual network).
 * Supports controlled failure injection for testing.
 */
export class Transport {
  private requestHandler: RequestHandler | null = null;
  private dropNextRequest = false;
  private dropNextResponse = false;

  /**
   * Register the request handler (Adapter B).
   * Only one handler can be registered at a time.
   */
  registerRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  /**
   * Send a request from Adapter A to Adapter B.
   *
   * Behavior:
   *   - If dropNextRequest is set: throw MessageDroppedError (request lost)
   *   - Otherwise: deliver to Adapter B
   *   - If dropNextResponse is set: throw MessageDroppedError (response lost)
   *   - Otherwise: return response
   *
   * Throws MessageDroppedError if request or response is dropped.
   * Throws Error if no handler is registered.
   */
  async sendRequest(request: AdapterRequest): Promise<AdapterResponse> {
    // Check for request drop
    if (this.dropNextRequest) {
      this.dropNextRequest = false;  // Reset flag
      throw new MessageDroppedError('request');
    }

    if (!this.requestHandler) {
      throw new Error('No request handler registered (Adapter B not initialized)');
    }

    // Deliver request to Adapter B
    const response = await this.requestHandler(request);

    // Check for response drop
    if (this.dropNextResponse) {
      this.dropNextResponse = false;  // Reset flag
      throw new MessageDroppedError('response');
    }

    // Return response normally
    return response;
  }

  /**
   * Configure the transport to drop the next request.
   *
   * The request will not reach Adapter B.
   * Adapter A will receive MessageDroppedError.
   */
  dropNextRequestMessage(): void {
    this.dropNextRequest = true;
  }

  /**
   * Configure the transport to drop the next response.
   *
   * The request will be processed by Adapter B (side effect executed).
   * But Adapter A will not receive the response (MessageDroppedError).
   */
  dropNextResponseMessage(): void {
    this.dropNextResponse = true;
  }

  /**
   * Clear all failure flags (for test cleanup).
   */
  clearFailureFlags(): void {
    this.dropNextRequest = false;
    this.dropNextResponse = false;
  }

  /**
   * Clear the registered handler (for test cleanup).
   */
  unregisterRequestHandler(): void {
    this.requestHandler = null;
  }
}
