import { GeminiAdapter, type GeminiGenerateContentClient } from "../../../src/adapters/gemini/geminiAdapter";
import { ProviderError } from "../../../src/errors";
import type { GatewayCompletionRequest } from "../../../src/adapters/types";

function makeClient(generateContent: GeminiGenerateContentClient["generateContent"]): GeminiGenerateContentClient {
  return { generateContent };
}

describe("GeminiAdapter", () => {
  const request: GatewayCompletionRequest = {
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "Let me think." },
    ],
  };

  it("extracts system messages into systemInstruction and maps assistant -> model", async () => {
    const generateContent = jest.fn().mockResolvedValue({
      text: "4",
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    });
    const adapter = new GeminiAdapter(makeClient(generateContent));

    await adapter.complete(request);

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: "Be concise.",
        contents: [
          { role: "user", parts: [{ text: "What is 2+2?" }] },
          { role: "model", parts: [{ text: "Let me think." }] },
        ],
      }),
    );
  });

  it("maps a successful response into a GatewayCompletionResult with computed cost", async () => {
    const generateContent = jest.fn().mockResolvedValue({
      text: "4",
      usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 },
    });
    const adapter = new GeminiAdapter(makeClient(generateContent));

    const result = await adapter.complete(request);

    expect(result).toMatchObject({
      content: "4",
      provider: "gemini",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      costUsd: 0.5,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty string when the response has no text", async () => {
    const generateContent = jest.fn().mockResolvedValue({
      text: "",
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
    });
    const adapter = new GeminiAdapter(makeClient(generateContent));

    const result = await adapter.complete(request);

    expect(result.content).toBe("");
  });

  it("wraps a client failure in a ProviderError without swallowing the cause", async () => {
    const cause = new Error("rate limited upstream");
    const generateContent = jest.fn().mockRejectedValue(cause);
    const adapter = new GeminiAdapter(makeClient(generateContent));

    await expect(adapter.complete(request)).rejects.toMatchObject({
      constructor: ProviderError,
      provider: "gemini",
      cause,
    });
  });

  it("throws a ProviderError for a model with no configured pricing", async () => {
    const generateContent = jest.fn().mockResolvedValue({
      text: "hi",
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const adapter = new GeminiAdapter(makeClient(generateContent), "gemini-unknown-model");

    await expect(adapter.complete(request)).rejects.toThrow(ProviderError);
  });
});
