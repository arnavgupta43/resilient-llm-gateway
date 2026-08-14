import { createHash } from "node:crypto";
import { hashApiKey } from "../../../src/auth/hashApiKey";

describe("hashApiKey", () => {
  it("matches a plain SHA-256 hex digest of the input", () => {
    const expected = createHash("sha256").update("dev-free-key").digest("hex");
    expect(hashApiKey("dev-free-key")).toBe(expected);
  });

  it("produces the same hash for the same input", () => {
    expect(hashApiKey("some-secret-key")).toBe(hashApiKey("some-secret-key"));
  });

  it("produces different hashes for different input", () => {
    expect(hashApiKey("key-a")).not.toBe(hashApiKey("key-b"));
  });

  it("returns a 64-character lowercase hex string", () => {
    expect(hashApiKey("any-key")).toMatch(/^[0-9a-f]{64}$/);
  });
});
