import { createRequestsRepo, type RequestLogEntry } from "../../../src/db/requestsRepo";

describe("requestsRepo.logRequest", () => {
  const entry: RequestLogEntry = {
    apiKeyId: "key-123",
    featureId: "doc-summarizer",
    provider: "anthropic",
    tier: "complex",
    promptTokens: 120,
    completionTokens: 45,
    costUsd: 0.001035,
    latencyMs: 812,
  };

  it("inserts a row into the requests table with all fields in order", async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const repo = createRequestsRepo({ query });

    await repo.logRequest(entry);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO requests/i);
    expect(params).toEqual([
      entry.apiKeyId,
      entry.featureId,
      entry.provider,
      entry.tier,
      entry.promptTokens,
      entry.completionTokens,
      entry.costUsd,
      entry.latencyMs,
    ]);
  });

  it("propagates a query failure rather than swallowing it", async () => {
    const dbError = new Error("connection terminated");
    const query = jest.fn().mockRejectedValue(dbError);
    const repo = createRequestsRepo({ query });

    await expect(repo.logRequest(entry)).rejects.toBe(dbError);
  });
});
