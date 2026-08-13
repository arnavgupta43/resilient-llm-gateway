import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "../logger/context";

const CORRELATION_HEADER = "x-request-id";
const API_KEY_HEADER = "x-api-key";

// Must be the first middleware mounted: everything downstream (routes,
// adapters, error handler) reads its logging context from ALS rather than
// having it passed in, so the store has to exist before anything else runs.
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = req.header(CORRELATION_HEADER) ?? randomUUID();
  const apiKeyId = req.header(API_KEY_HEADER);

  res.setHeader(CORRELATION_HEADER, correlationId);

  runWithRequestContext({ correlationId, apiKeyId }, () => next());
}
