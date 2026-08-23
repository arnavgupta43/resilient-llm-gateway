import type { GatewayCompletionRequest } from "../adapters/types";
import type { RoutingTier } from "../orchestrator/types";

// hld.md §3.1. Exact-match against the caller's own task_type string.
const TASK_TYPE_TIER: Record<string, RoutingTier> = {
  summarization: "simple",
  classification: "simple",
  extraction: "simple",
  translation: "simple",
  code_generation: "complex",
  debugging: "complex",
  reasoning: "complex",
  analysis: "complex",
};

const LONG_PROMPT_THRESHOLD_CHARS = 600; // hld.md §3.2

const CODE_BLOCK_PATTERN = /```/;

const REASONING_KEYWORDS = ["explain step by step", "step by step", "prove", "debug", "walk me through", "why does"];

function latestUserMessageContent(request: GatewayCompletionRequest): string | undefined {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message !== undefined && message.role === "user") return message.content;
  }
  return undefined;
}

function matchesHeuristic(content: string): boolean {
  if (content.length > LONG_PROMPT_THRESHOLD_CHARS) return true;
  if (CODE_BLOCK_PATTERN.test(content)) return true;
  const lower = content.toLowerCase();
  return REASONING_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function chooseTier(request: GatewayCompletionRequest): RoutingTier {
  if (request.taskType !== undefined) {
    // noUncheckedIndexedAccess means this lookup is typed `RoutingTier |
    // undefined` even after an `in` check (TS doesn't narrow index-signature
    // reads that way) -- checking the looked-up value directly is the same
    // "known key" check in practice, since every table value is defined.
    const tier = TASK_TYPE_TIER[request.taskType];
    if (tier !== undefined) return tier;
  }

  const content = latestUserMessageContent(request);
  if (content !== undefined && matchesHeuristic(content)) return "complex";

  return "simple";
}
