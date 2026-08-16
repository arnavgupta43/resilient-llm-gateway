export interface CircuitBreakerConfig {
  failureThreshold: number; // N
  failureWindowSeconds: number; // W
  cooldownSeconds: number; // T
  halfOpenLeaseSeconds: number; // reuses T — see hld.md §5.3
}

// architecture.md §11.
export const CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowSeconds: 60,
  cooldownSeconds: 30,
  halfOpenLeaseSeconds: 30,
};
