export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreaker {
  // Returns the subset of `providers` currently allowed to be tried, in the
  // same order they were passed in. One Redis round-trip regardless of list
  // length (docs/design/circuit-breaker-fallback-orchestrator/hld.md §5.3).
  attemptBatch<T extends string>(providers: T[]): Promise<T[]>;

  // Records the outcome of an actual attempt. Never throws — a Redis
  // failure here is caught and logged internally, since a bookkeeping write
  // failing must never affect the caller's control flow.
  report(provider: string, success: boolean): Promise<void>;
}
