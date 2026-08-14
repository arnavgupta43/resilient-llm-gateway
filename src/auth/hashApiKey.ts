import { createHash } from "node:crypto";

// SHA-256, not a slow password hash (bcrypt/scrypt): API keys are
// high-entropy random secrets, not human-chosen passwords, so there's no
// guessing threat to defend against, and paying bcrypt's deliberate
// slowness on every request lookup would be pure cost with no benefit.
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
