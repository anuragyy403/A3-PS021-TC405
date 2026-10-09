/**
 * Dialog routes — E3–E9 (docs/API_DESIGN.md §2).
 *
 * Each route validates input and calls the runtime.  Simulated drops come back
 * as 200 SendResult (§4), never as HTTP errors.
 */

import { Router } from 'express';

import { ConflictError, NotFoundError, TaskMismatchError } from '../../errors.js';
import type { SimulationRuntime } from '../../runtime/SimulationRuntime.js';
import { HttpError } from '../errorMiddleware.js';
import {
  DialogParams,
  DialogSeqParams,
  DialogsQuery,
  EmptyBody,
  FailBody,
  RetryBody,
  SendBody,
  StartDialogBody,
  asyncRoute,
} from '../validation.js';

export function dialogRoutes(runtime: SimulationRuntime): Router {
  const router = Router();

  // E3 — dialog summaries
  router.get('/dialogs', asyncRoute((req, res) => {
    const { state, limit } = DialogsQuery.parse(req.query);
    res.json({ dialogs: runtime.listDialogs({ ...(state ? { state } : {}), limit }) });
  }));

  // E4 — one dialog with processed requests, send log and ledger
  router.get('/dialogs/:dialogId', asyncRoute((req, res) => {
    const { dialogId } = DialogParams.parse(req.params);
    res.json(runtime.getDialog(dialogId));
  }));

  // E5 — start a dialog
  router.post('/dialogs', asyncRoute(async (req, res) => {
    const { task_id } = StartDialogBody.parse(req.body);
    res.status(201).json({ dialog: await runtime.startDialog(task_id) });
  }));

  // E6 — send the next request
  router.post('/dialogs/:dialogId/requests', asyncRoute(async (req, res) => {
    const { dialogId }       = DialogParams.parse(req.params);
    const { payload, fault } = SendBody.parse(req.body);
    res.json(await runtime.send(dialogId, payload, fault));
  }));

  // E7 — retry an existing seq (stored payload; no payload accepted)
  router.post('/dialogs/:dialogId/requests/:seq/retry', asyncRoute(async (req, res) => {
    const { dialogId, seq } = DialogSeqParams.parse(req.params);
    const { fault }         = RetryBody.parse(req.body);

    runtime.getDialog(dialogId);            // unknown dialog → NotFoundError → 404 DIALOG_NOT_FOUND
    try {
      res.json(await runtime.retry(dialogId, seq, fault));
    } catch (error) {
      if (error instanceof NotFoundError) { // the dialog exists, so it is the seq
        throw new HttpError(404, 'REQUEST_NOT_FOUND', error.message);
      }
      throw error;
    }
  }));

  // E8 — complete → COMMITTED / RECOVERED
  router.post('/dialogs/:dialogId/complete', asyncRoute(async (req, res) => {
    const { dialogId } = DialogParams.parse(req.params);
    EmptyBody.parse(req.body);
    try {
      res.json({ dialog: await runtime.complete(dialogId) });
    } catch (error) {
      if (error instanceof ConflictError && !(error instanceof TaskMismatchError)) {
        const pending_seqs = runtime.getDialog(dialogId).dialog.pending_seqs;
        throw new HttpError(409, 'PENDING_REQUESTS', error.message, { pending_seqs });
      }
      throw error;
    }
  }));

  // E9 — abort → FAILED
  router.post('/dialogs/:dialogId/fail', asyncRoute(async (req, res) => {
    const { dialogId } = DialogParams.parse(req.params);
    const { reason }   = FailBody.parse(req.body);
    res.json({ dialog: await runtime.fail(dialogId, reason) });
  }));

  return router;
}
