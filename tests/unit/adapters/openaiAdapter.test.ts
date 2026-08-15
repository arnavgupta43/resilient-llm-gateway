import { OpenAIAdapter, type OpenAIChatClient } from "../../../src/adapters/openai/openaiAdapter";
import { ProviderError } from "../../../src/errors";
import type { GatewayCompletionRequest } from "../../../src/adapters/types";

function makeClient(create: OpenAIChatClient["chat"]["completions"]["create"]): OpenAIChatClient {
  return { chat: { completions: { create } } };
}

describe("OpenAIAdapter", () => {
  const request: GatewayCompletionRequest = {
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "What is 2+2?" },
    ],
  };

  it("passes the system message through as a normal message role", async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: "4" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    const adapter = new OpenAIAdapter(makeClient(create));

    await adapter.complete(request);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "What is 2+2?" },
        ],
      }),
    );
  });

  it("maps a successful response into a GatewayCompletionResult with computed cost", async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: "4" } }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    });
    const adapter = new OpenAIAdapter(makeClient(create));

    const result = await adapter.complete(request);

    expect(result).toMatchObject({
      content: "4",
      provider: "openai",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      costUsd: 0.75,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty string when the response has no message content", async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    });
    const adapter = new OpenAIAdapter(makeClient(create));

    const result = await adapter.complete(request);

    expect(result.content).toBe("");
  });

  it("wraps a client failure in a ProviderError without swallowing the cause", async () => {
    const cause = new Error("rate limited upstream");
    const create = jest.fn().mockRejectedValue(cause);
    const adapter = new OpenAIAdapter(makeClient(create));

    await expect(adapter.complete(request)).rejects.toMatchObject({
      constructor: ProviderError,
      provider: "openai",
      cause,
    });
  });

  it("throws a ProviderError for a model with no configured pricing", async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const adapter = new OpenAIAdapter(makeClient(create), "gpt-unknown-model");

    await expect(adapter.complete(request)).rejects.toThrow(ProviderError);
  });
});
