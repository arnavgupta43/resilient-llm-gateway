import type { NextFunction, Request, Response } from "express";
import { GatewayError } from "../errors";
import { getLogger } from "../logger";

// Express only treats a middleware as an error handler if it takes all four
// arguments — `next` must stay in the signature even though it's unused.
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const logger = getLogger();

  if (err instanceof GatewayError) {
    logger[err.isOperational ? "warn" : "error"]({ err }, err.message);
    res.status(err.httpStatus).json({ error: { type: err.name, message: err.message } });
    return;
  }

  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: { type: "InternalError", message: "Internal server error" } });
}
