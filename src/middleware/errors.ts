import type { NextFunction, Response } from 'express';
import { LedgerError } from '../services/ledger.js';

/**
 * Map a thrown error to an HTTP response: a `LedgerError` becomes its declared
 * status + message; anything else is forwarded to the Express error handler.
 * Shared by the route modules so the mapping stays consistent across routers.
 */
export function sendLedgerError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof LedgerError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}
