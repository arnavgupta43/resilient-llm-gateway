import { AnthropicAdapter, type AnthropicMessagesClient } from "../../../src/adapters/anthropic/anthropicAdapter";
import { ProviderError } from "../../../src/errors";
import type { GatewayCompletionRequest } from "../../../src/adapters/types";

function makeClient(create: AnthropicMessagesClient["messages"]["create"]): AnthropicMessagesClient {
  return { messages: { create } };
}

describe("AnthropicAdapter", () => {
  const request: GatewayCompletionRequest = {
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "What is 2+2?" },
    ],
  };

  it("splits system messages out and forwards user/assistant messages to the client", async () => {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "4" }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const adapter = new AnthropicAdapter(makeClient(create));

    await adapter.complete(request);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "Be concise.",
        messages: [{ role: "user", content: "What is 2+2?" }],
      }),
    );
  });

  it("maps a successful response into a GatewayCompletionResult with computed cost", async () => {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "4" }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const adapter = new AnthropicAdapter(makeClient(create));

    const result = await adapter.complete(request);

    expect(result).toMatchObject({
      content: "4",
      provider: "anthropic",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      costUsd: 18,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("joins multiple text blocks and ignores non-text blocks", async () => {
    const create = jest.fn().mockResolvedValue({
      content: [
        { type: "text", text: "Hello, " },
        { type: "tool_use", text: undefined },
        { type: "text", text: "world." },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const adapter = new AnthropicAdapter(makeClient(create));

    const result = await adapter.complete(request);

    expect(result.content).toBe("Hello, world.");
  });

  it("wraps a client failure in a ProviderError without swallowing the cause", async () => {
    const cause = new Error("rate limited upstream");
    const create = jest.fn().mockRejectedValue(cause);
    const adapter = new AnthropicAdapter(makeClient(create));

    await expect(adapter.complete(request)).rejects.toMatchObject({
      constructor: ProviderError,
      provider: "anthropic",
      cause,
    });
  });

  it("throws a ProviderError for a model with no configured pricing", async () => {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const adapter = new AnthropicAdapter(makeClient(create), "claude-unknown-model");

    await expect(adapter.complete(request)).rejects.toThrow(ProviderError);
  });
});
