/**
 * Request schemas (docs/API_DESIGN.md §2) and small route helpers.
 *
 * Bodies are .strict(): unknown keys are rejected with 400, so a client can
 * never believe it changed something the API ignores (e.g. a payload on retry).
 * Query strings tolerate unknown parameters.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';

import { LifecycleStateSchema } from '../types/index.js';

export const DialogId = z.string().min(1).max(128);
export const TaskId   = z.string().min(1).max(128);
export const Seq      = z.coerce.number().int().positive();
export const Fault    = z.enum(['drop_request', 'drop_response']);
const Limit           = z.coerce.number().int().min(1).max(500).default(200);

// ---- params ---------------------------------------------------------------
export const DialogParams      = z.object({ dialogId: DialogId });
export const DialogSeqParams   = z.object({ dialogId: DialogId, seq: Seq });
export const AdapterParams     = z.object({ adapter: z.enum(['A', 'B']) });

// ---- bodies ---------------------------------------------------------------
export const EmptyBody         = z.object({}).strict();
export const StartDialogBody   = z.object({ task_id: TaskId }).strict();                       // E5
export const SendBody          = z.object({ payload: z.unknown().default(null),               // E6
                                            fault: Fault.optional() }).strict();
export const RetryBody         = z.object({ fault: Fault.optional() }).strict();               // E7
export const FailBody          = z.object({ reason: z.string().min(1).max(200) }).strict();    // E9
export const ResetBody         = z.object({ confirm: z.literal('RESET') }).strict();           // E14
export const RunScenarioBody   = z.object({                                                    // E12
  step_delay_ms: z.number().int().min(0).max(1000).default(0),
  variant:       z.enum(['response_lost', 'request_lost']).optional(),
}).strict();

// ---- queries --------------------------------------------------------------
export const DialogsQuery      = z.object({ state: LifecycleStateSchema.optional(), limit: Limit }); // E3
export const EventsQuery       = z.object({ since: z.coerce.number().int().min(0).default(0),        // E13
                                            limit: Limit });

/** Express 4 does not catch rejected promises; forward them to the error middleware. */
export function asyncRoute(
  fn: (req: Request, res: Response) => Promise<unknown> | unknown,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };
}
