import { createApiKeysRepo } from "../../../src/auth/apiKeysRepo";

describe("apiKeysRepo.findByKeyHash", () => {
  it("returns the matching record when a row is found", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "key-id-1", tier: "pro" }] });
    const repo = createApiKeysRepo({ query });

    const result = await repo.findByKeyHash("some-hash");

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT id, tier FROM api_keys WHERE key_hash = \$1/i);
    expect(params).toEqual(["some-hash"]);
    expect(result).toEqual({ id: "key-id-1", tier: "pro" });
  });

  it("returns null when no row matches", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createApiKeysRepo({ query });

    const result = await repo.findByKeyHash("unknown-hash");

    expect(result).toBeNull();
  });

  it("propagates a query failure rather than swallowing it", async () => {
    const dbError = new Error("connection terminated");
    const query = jest.fn().mockRejectedValue(dbError);
    const repo = createApiKeysRepo({ query });

    await expect(repo.findByKeyHash("some-hash")).rejects.toBe(dbError);
  });
});
