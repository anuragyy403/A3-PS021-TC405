/**
 * Adapter message types for PS-021.
 *
 * These types define the messages exchanged between Adapter A and Adapter B
 * through the transport layer.
 *
 * NOT an MCP implementation.
 * NOT an A2A implementation.
 * Experimental schema for PS-021 demonstration purposes only.
 */

/**
 * Request sent from Adapter A to Adapter B.
 *
 * Contains the three identifiers required for correlation and deduplication:
 *   - dialog_id: correlation key
 *   - task_id:   task identity
 *   - seq:       request sequence / request_id for deduplication
 */
export interface AdapterRequest {
  dialog_id: string;
  task_id:   string;
  seq:       number;
  payload:   unknown;  // Mock business payload (deterministic for testing)
}

/**
 * Response sent from Adapter B back to Adapter A.
 *
 * Contains identifiers to correlate the response back to the request.
 */
export interface AdapterResponse {
  dialog_id: string;
  task_id:   string;
  seq:       number;
  status:    'ok' | 'duplicate' | 'error';
  result:    unknown;  // Result of processing (or stored duplicate result)
  error?:    string;   // Error message if status is 'error'
}
