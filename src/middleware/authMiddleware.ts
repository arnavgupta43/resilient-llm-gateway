import type { NextFunction, Request, Response } from "express";
import { AuthenticationError } from "../errors";
import { getRequestContext } from "../logger/context";
import { hashApiKey } from "../auth/hashApiKey";
import type { ApiKeysRepo } from "../auth/apiKeysRepo";

const API_KEY_HEADER = "x-api-key";

// No try/catch: Express 5 auto-catches a rejected promise from an async
// handler and routes it to errorHandler, so a plain throw is enough (see
// CLAUDE.md "Error Handling"). completions.ts's try/catch exists only to
// translate ZodError into ValidationError — that's a special case, not the
// default shape.
export function createAuthMiddleware(apiKeysRepo: ApiKeysRepo) {
  return async function authMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const rawKey = req.header(API_KEY_HEADER);
    if (!rawKey) throw new AuthenticationError("Missing x-api-key header");

    const record = await apiKeysRepo.findByKeyHash(hashApiKey(rawKey));
    if (!record) throw new AuthenticationError("Invalid API key");

    const context = getRequestContext();
    if (context) {
      context.apiKeyId = record.id;
      context.rateLimitTier = record.tier;
    }

    next();
  };
}
