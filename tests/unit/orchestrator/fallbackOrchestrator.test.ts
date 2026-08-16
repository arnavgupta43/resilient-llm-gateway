import { createFallbackOrchestrator } from "../../../src/orchestrator/fallbackOrchestrator";
import { ProviderError } from "../../../src/errors";
import type { CircuitBreaker } from "../../../src/circuitBreaker/types";
import type { GatewayCompletionResult, ProviderAdapter } from "../../../src/adapters/types";
import type { ProviderName } from "../../../src/orchestrator/types";

function makeAdapter(name: ProviderName, complete: ProviderAdapter["complete"]): ProviderAdapter {
  return { name, complete };
}

function makeResult(provider: string): GatewayCompletionResult {
  return {
    content: `response from ${provider}`,
    provider,
    model: "some-model",
    promptTokens: 10,
    completionTokens: 5,
    costUsd: 0.001,
    latencyMs: 100,
  };
}

// Defaults to "allow everything, no-op report" — individual tests override
// with jest.fn() implementations where the behavior under test needs it.
function makeCircuitBreaker(overrides: Partial<CircuitBreaker> = {}): CircuitBreaker {
  return {
    attemptBatch: jest.fn(async <T extends string>(providers: T[]) => providers),
    report: jest.fn(async () => undefined),
    ...overrides,
  };
}

const request = { messages: [{ role: "user" as const, content: "hi" }] };

describe("FallbackOrchestrator", () => {
  it("returns the first provider's result when it succeeds, without trying the rest", async () => {
    const anthropicComplete = jest.fn().mockResolvedValue(makeResult("anthropic"));
    const openaiComplete = jest.fn();
    const circuitBreaker = makeCircuitBreaker();
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", anthropicComplete),
        openai: makeAdapter("openai", openaiComplete),
        gemini: makeAdapter("gemini", jest.fn()),
      },
      circuitBreaker,
    );

    const outcome = await orchestrator.complete(request, "complex");

    expect(outcome.tier).toBe("complex");
    expect(outcome.result.provider).toBe("anthropic");
    expect(anthropicComplete).toHaveBeenCalledTimes(1);
    expect(openaiComplete).not.toHaveBeenCalled();
    expect(circuitBreaker.report).toHaveBeenCalledWith("anthropic", true);
  });

  it("falls back to the next provider in the tier when the first throws ProviderError", async () => {
    const anthropicComplete = jest.fn().mockRejectedValue(new ProviderError("down", "anthropic"));
    const openaiComplete = jest.fn().mockResolvedValue(makeResult("openai"));
    const circuitBreaker = makeCircuitBreaker();
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", anthropicComplete),
        openai: makeAdapter("openai", openaiComplete),
        gemini: makeAdapter("gemini", jest.fn()),
      },
      circuitBreaker,
    );

    const outcome = await orchestrator.complete(request, "complex");

    expect(outcome.result.provider).toBe("openai");
    expect(outcome.tier).toBe("complex");
    expect(circuitBreaker.report).toHaveBeenCalledWith("anthropic", false);
    expect(circuitBreaker.report).toHaveBeenCalledWith("openai", true);
  });

  it("tries providers strictly in order, never concurrently", async () => {
    const callOrder: string[] = [];
    const anthropicComplete = jest.fn().mockImplementation(async () => {
      callOrder.push("anthropic-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      callOrder.push("anthropic-end");
      throw new ProviderError("down", "anthropic");
    });
    const openaiComplete = jest.fn().mockImplementation(async () => {
      callOrder.push("openai-start");
      return makeResult("openai");
    });
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", anthropicComplete),
        openai: makeAdapter("openai", openaiComplete),
        gemini: makeAdapter("gemini", jest.fn()),
      },
      makeCircuitBreaker(),
    );

    await orchestrator.complete(request, "complex");

    expect(callOrder).toEqual(["anthropic-start", "anthropic-end", "openai-start"]);
  });

  it("skips providers the circuit breaker excludes from attemptBatch", async () => {
    const anthropicComplete = jest.fn();
    const openaiComplete = jest.fn().mockResolvedValue(makeResult("openai"));
    const circuitBreaker = makeCircuitBreaker({
      // anthropic's breaker is open — filtered out before the loop even starts
      attemptBatch: async <T extends string>(providers: T[]): Promise<T[]> =>
        providers.filter((provider) => provider === "openai"),
    });
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", anthropicComplete),
        openai: makeAdapter("openai", openaiComplete),
        gemini: makeAdapter("gemini", jest.fn()),
      },
      circuitBreaker,
    );

    const outcome = await orchestrator.complete(request, "complex");

    expect(outcome.result.provider).toBe("openai");
    expect(anthropicComplete).not.toHaveBeenCalled();
  });

  it("rethrows a non-ProviderError without falling back or reporting to the breaker", async () => {
    const bug = new Error("programmer error");
    const anthropicComplete = jest.fn().mockRejectedValue(bug);
    const openaiComplete = jest.fn();
    const circuitBreaker = makeCircuitBreaker();
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", anthropicComplete),
        openai: makeAdapter("openai", openaiComplete),
        gemini: makeAdapter("gemini", jest.fn()),
      },
      circuitBreaker,
    );

    await expect(orchestrator.complete(request, "complex")).rejects.toBe(bug);
    expect(openaiComplete).not.toHaveBeenCalled();
    expect(circuitBreaker.report).not.toHaveBeenCalled();
  });

  it("downgrades to the other tier when every provider in the starting tier is exhausted", async () => {
    const anthropicComplete = jest.fn().mockRejectedValue(new ProviderError("down", "anthropic"));
    const openaiComplete = jest.fn().mockRejectedValue(new ProviderError("down", "openai"));
    const geminiComplete = jest.fn().mockResolvedValue(makeResult("gemini"));
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", anthropicComplete),
        openai: makeAdapter("openai", openaiComplete),
        gemini: makeAdapter("gemini", geminiComplete),
      },
      makeCircuitBreaker(),
    );

    const outcome = await orchestrator.complete(request, "complex");

    expect(outcome.result.provider).toBe("gemini");
    expect(outcome.tier).toBe("simple"); // reflects the tier that actually served it
  });

  it("throws ProviderError when both tiers are exhausted", async () => {
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", jest.fn().mockRejectedValue(new ProviderError("down", "anthropic"))),
        openai: makeAdapter("openai", jest.fn().mockRejectedValue(new ProviderError("down", "openai"))),
        gemini: makeAdapter("gemini", jest.fn().mockRejectedValue(new ProviderError("down", "gemini"))),
      },
      makeCircuitBreaker(),
    );

    await expect(orchestrator.complete(request, "complex")).rejects.toBeInstanceOf(ProviderError);
  });

  it("falls open and still tries every provider when attemptBatch itself rejects", async () => {
    const anthropicComplete = jest.fn().mockResolvedValue(makeResult("anthropic"));
    const circuitBreaker = makeCircuitBreaker({
      attemptBatch: jest.fn().mockRejectedValue(new Error("redis down")),
    });
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", anthropicComplete),
        openai: makeAdapter("openai", jest.fn()),
        gemini: makeAdapter("gemini", jest.fn()),
      },
      circuitBreaker,
    );

    const outcome = await orchestrator.complete(request, "complex");

    expect(outcome.result.provider).toBe("anthropic");
  });

  it("starts in the simple tier directly when passed as the starting tier", async () => {
    const geminiComplete = jest.fn().mockResolvedValue(makeResult("gemini"));
    const anthropicComplete = jest.fn();
    const orchestrator = createFallbackOrchestrator(
      {
        anthropic: makeAdapter("anthropic", anthropicComplete),
        openai: makeAdapter("openai", jest.fn()),
        gemini: makeAdapter("gemini", geminiComplete),
      },
      makeCircuitBreaker(),
    );

    const outcome = await orchestrator.complete(request, "simple");

    expect(outcome.result.provider).toBe("gemini");
    expect(outcome.tier).toBe("simple");
    expect(anthropicComplete).not.toHaveBeenCalled();
  });
});
