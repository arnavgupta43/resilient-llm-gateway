import { AsyncLocalStorage } from "node:async_hooks";
import type { RateLimitTier } from "../rateLimiter/types";

export interface RequestContext {
  correlationId: string;
  apiKeyId?: string;
  featureId?: string;
  rateLimitTier?: RateLimitTier;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}
