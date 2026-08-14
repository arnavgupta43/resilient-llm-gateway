import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "../logger/context";

const CORRELATION_HEADER = "x-request-id";

// Must be the first middleware mounted: everything downstream (routes,
// adapters, error handler) reads its logging context from ALS rather than
// having it passed in, so the store has to exist before anything else runs.
//
// Deliberately does not touch x-api-key: authMiddleware resolves the raw
// header into a verified internal apiKeyId and writes that into this same
// context once it's known. The raw secret itself must never end up here,
// since getLogger() binds this context onto every log line.
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = req.header(CORRELATION_HEADER) ?? randomUUID();

  res.setHeader(CORRELATION_HEADER, correlationId);

  runWithRequestContext({ correlationId }, () => next());
}
