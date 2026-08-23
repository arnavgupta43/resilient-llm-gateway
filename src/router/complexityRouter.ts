import type { GatewayCompletionRequest } from "../adapters/types";
import type { RoutingTier } from "../orchestrator/types";

// hld.md §3.1. Exact-match against the caller's own task_type string. A Map,
// not a plain object -- an object literal inherits Object.prototype, so a
// caller-supplied task_type of "constructor"/"toString"/"hasOwnProperty"
// would otherwise resolve to a built-in function instead of undefined,
// which would then flow out of chooseTier typed as (but not actually) a
// RoutingTier. Map.get() has no prototype-chain lookup, so an unknown key
// -- any unknown key -- always returns undefined.
const TASK_TYPE_TIER = new Map<string, RoutingTier>([
  ["summarization", "simple"],
  ["classification", "simple"],
  ["extraction", "simple"],
  ["translation", "simple"],
  ["code_generation", "complex"],
  ["debugging", "complex"],
  ["reasoning", "complex"],
  ["analysis", "complex"],
]);

const LONG_PROMPT_THRESHOLD_CHARS = 600; // hld.md §3.2

const CODE_BLOCK_PATTERN = /```/;

// "explain step by step" isn't listed separately -- it's always a superset
// match of "step by step", so it can never fire independently.
const REASONING_KEYWORDS = ["step by step", "prove", "debug", "walk me through", "why does"];

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
    const tier = TASK_TYPE_TIER.get(request.taskType);
    if (tier !== undefined) return tier;
  }

  const content = latestUserMessageContent(request);
  if (content !== undefined && matchesHeuristic(content)) return "complex";

  return "simple";
}
